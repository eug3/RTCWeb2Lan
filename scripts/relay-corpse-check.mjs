/**
 * Relay regression check against a LIVE fdn.
 *
 *   node scripts/relay-corpse-check.mjs ws://127.0.0.1:8802/__lan/ws
 *   node scripts/relay-corpse-check.mjs wss://sense.jshuaxin.net/__lan/ws   # needs -e
 *
 * It reproduces the 2026-11-01 outage, in which every browser arriving at the
 * public site was rejected for 45 minutes:
 *
 *   1. two browsers arrive while no agent is connected  -> both queue
 *   2. both give up and close (page closed, connection dropped)
 *   3. a real browser arrives and waits
 *   4. an agent dials a slot
 *
 * Before the fix step 4 handed that slot to one of the closed browsers: the
 * write to it timed out ("relay to browser failed: ... i/o timeout") and the
 * real browser was left waiting forever — "answer timed out" in the page.
 *
 * Exit code 0 = the live browser got the agent, 1 = regression reproduced.
 */

const url = process.argv[2] ?? "ws://127.0.0.1:8802/__lan/ws";
const room = "diagnose-" + Date.now().toString(36);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(role, label) {
  const ws = new WebSocket(`${url}?room=${room}&role=${role}`);
  const inbox = [];
  ws.addEventListener("message", (ev) => {
    try {
      inbox.push(JSON.parse(String(ev.data)));
    } catch {
      inbox.push({ type: "unparsed", raw: String(ev.data) });
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, inbox, label }), { once: true });
    ws.addEventListener("error", () => reject(new Error(`${label}: connect failed`)), { once: true });
    setTimeout(() => reject(new Error(`${label}: connect timed out`)), 8000);
  });
}

const send = (peer, msg) => peer.ws.send(JSON.stringify(msg));

/** Wait until a frame of `type` appears (draining everything before it). */
async function expect(peer, type, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = peer.inbox.findIndex((m) => m.type === type);
    if (i >= 0) {
      peer.inbox.splice(0, i + 1);
      return true;
    }
    await sleep(30);
  }
  return false;
}

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log("  FAIL:", msg);
};

console.log(`relay: ${url}\nroom:  ${room}\n`);

// 1. Two browsers queue while no agent is connected.
const deadA = await open("browser", "dead-a");
const deadB = await open("browser", "dead-b");
await sleep(200);
console.log("1. two browsers queued with no agent present");

// 2. Both give up. The relay only notices a closed socket when writing to it,
//    so a last frame each, then close — exactly what a page does.
send(deadA, { v: 1, type: "hello", role: "browser", session: "dead-a" });
send(deadB, { v: 1, type: "hello", role: "browser", session: "dead-b" });
await sleep(200);
deadA.ws.close();
deadB.ws.close();
await sleep(600);
console.log("2. both closed (the relay has no reason to notice yet)");

// 3. A live browser arrives.
const live = await open("browser", "live");
send(live, { v: 1, type: "hello", role: "browser", session: "live" });
await expect(live, "waiting");
console.log("3. live browser queued");

// 4. An agent dials a slot.
const agent = await open("agent", "agent");
console.log("4. agent dialled a slot");

// 5. The live browser's frame must reach the agent, not a corpse.
send(live, { v: 1, type: "hello", role: "browser", session: "live" });
if (!(await expect(agent, "hello"))) fail("agent never received the live browser's frame (paired with a corpse)");
else console.log("5. agent received the live browser's frame");

// 6. And the reply must come back.
send(agent, { v: 1, type: "hello", role: "agent", session: "live" });
if (!(await expect(live, "hello"))) fail("live browser never received the agent's reply");
else console.log("6. live browser received the agent's reply");

for (const p of [live, agent]) p.ws.close();

console.log(failures.length ? "\nFAIL: regression reproduced" : "\nPASS: the live browser was paired with the agent");
process.exit(failures.length ? 1 : 0);
