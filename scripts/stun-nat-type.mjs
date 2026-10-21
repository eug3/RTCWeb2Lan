import dgram from "node:dgram";

function stunOnce(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, timeoutMs);
    const txid = Buffer.alloc(12); for (let i=0;i<12;i++) txid[i] = Math.floor(Math.random()*256);
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001,0); msg.writeUInt16BE(0,2); msg.writeUInt32BE(0x2112A442,4); txid.copy(msg,8);
    sock.on("message", (buf) => {
      clearTimeout(timer); try { sock.close(); } catch {}
      let off = 20, mapped = null;
      while (off + 4 <= buf.length) {
        const at = buf.readUInt16BE(off), al = buf.readUInt16BE(off+2); off += 4;
        if ((at === 0x0020 || at === 0x0001) && off + 8 <= buf.length && buf[off+1] === 0x01) {
          const p = buf.readUInt16BE(off+2) ^ 0x2112;
          mapped = [buf[off+4]^0x21,buf[off+5]^0x12,buf[off+6]^0xA4,buf[off+7]^0x42].join(".") + ":" + p;
          break;
        }
        off += al + ((4 - (al % 4)) % 4);
      }
      resolve(mapped);
    });
    sock.on("error", () => { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); });
    sock.send(msg, port, host);
  });
}

const host = "stun.chat.bilibili.com", port = 3478;
const results = [];
for (let i = 0; i < 5; i++) { results.push(await stunOnce(host, port)); }
console.log("同一 STUN，连续 5 次：");
results.forEach((r, i) => console.log("  " + (i+1) + ". " + r));
const ips = new Set(results.map(r => r && r.split(":")[0]));
const ports = new Set(results.map(r => r && r.split(":")[1]));
console.log("");
console.log("不同出口 IP 数: " + ips.size + "  -> " + [...ips].join(", "));
console.log("不同源端口数: " + ports.size);
if (ips.size === 1 && ports.size === 1) console.log("=> 映射稳定（Cone NAT，打洞友好）");
else if (ips.size === 1) console.log("=> 端口随会话变化（受限/对称 NAT，打洞较难）");
else console.log("=> 出口 IP 不稳定（多出口/分流），打洞成功率低");
