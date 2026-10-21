import dgram from "node:dgram";

function stunBinding(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve({ ok:false, reason:"timeout" }); }, timeoutMs);
    // STUN Binding Request: type 0x0001, length 0, magic cookie 0x2112A442, 12-byte txid
    const txid = Buffer.alloc(12); for (let i=0;i<12;i++) txid[i] = Math.floor(Math.random()*256);
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); msg.writeUInt16BE(0, 2); msg.writeUInt32BE(0x2112A442, 4); txid.copy(msg, 8);
    sock.on("message", (buf) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      if (buf.length < 20) return resolve({ ok:false, reason:"short reply" });
      const type = buf.readUInt16BE(0);
      if (type !== 0x0101) return resolve({ ok:false, reason:"unexpected type 0x"+type.toString(16) });
      // walk attributes
      let off = 20; let mapped = null;
      while (off + 4 <= buf.length) {
        const at = buf.readUInt16BE(off); const al = buf.readUInt16BE(off+2);
        off += 4;
        if ((at === 0x0020 || at === 0x0001) && off + 8 <= buf.length) {
          const fam = buf[off+1];
          if (fam === 0x01) {
            const p = buf.readUInt16BE(off+2) ^ 0x2112;
            const ip = [buf[off+4]^0x21, buf[off+5]^0x12, buf[off+6]^0xA4, buf[off+7]^0x42].join(".");
            mapped = ip + ":" + p;
            break;
          }
        }
        off += al + ((4 - (al % 4)) % 4);
      }
      resolve({ ok:true, mapped, publicIP: mapped ? mapped.split(":")[0] : null });
    });
    sock.on("error", (e) => { clearTimeout(timer); try { sock.close(); } catch {} resolve({ ok:false, reason:e.message }); });
    sock.send(msg, port, host);
  });
}

const servers = [
  ["stun.chat.bilibili.com", 3478],
  ["stun.miwifi.com", 3478],
  ["stun.qq.com", 3478],
];
for (const [h, p] of servers) {
  const r = await stunBinding(h, p);
  console.log(h + ":" + p, "=>", JSON.stringify(r));
}
