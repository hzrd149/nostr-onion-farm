import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  kinds,
  nip19,
  nip44,
  NostrEvent,
  SimplePool,
} from "nostr-tools";
import { CashuMint, CashuWallet, getEncodedToken, MintQuoteState } from "@cashu/cashu-ts";
import inquirer from "inquirer";
import { getInboxes, getOutboxes } from "applesauce-core/helpers/mailboxes";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import qrcode from "qrcode-terminal";
import process from "node:process";

export function isHexKey(key?: string) {
  if (key?.toLowerCase()?.match(/^[0-9a-f]{64}$/)) return true;
  return false;
}

export function normalizeNsec(str: string) {
  if (str.startsWith("nsec")) return nip19.decode(str).data as Uint8Array;
  return hexToBytes(str);
}

function unixNow() {
  return Math.round(Date.now() / 1000);
}

// create relay pool
const pool = new SimplePool();

async function getUserMailboxes(pubkey: string) {
  const mailboxes = await pool.get(["wss://purplepag.es"], { kinds: [kinds.RelayList], authors: [pubkey] });
  if (!mailboxes) return {};

  return { inboxes: getInboxes(mailboxes), outboxes: getOutboxes(mailboxes) };
}

type Hop = {
  id?: string;
  pubkey: string;
  token: string;
  fee: number;
  relay?: string;
  expiration?: number;
};
async function growOnion(event: NostrEvent, hops: Hop[]) {
  let onion = event;

  function wrap(hop: Hop, i = 0) {
    const key = generateSecretKey();

    const name = people.find((person) => person.pubkey === hop.pubkey)?.name;
    console.log(`Wrapping for ${name}`);

    const conversationKey = nip44.getConversationKey(key, hop.pubkey);

    let kind = 20747;
    const tags: string[][] = [["cashu", nip44.encrypt(hop.token, conversationKey)]];

    if (hop.relay) tags.unshift(["p", hop.pubkey, hop.relay]);
    else tags.unshift(["p", hop.pubkey]);

    if (hop.expiration) {
      kind = 2747;
      tags.push(["expiration", String(hop.expiration)]);
    }

    // replace onion
    onion = finalizeEvent(
      {
        kind,
        created_at: Math.round(unixNow() + i * (Math.random() * 2)),
        content: nip44.encrypt(JSON.stringify(onion), conversationKey),
        tags,
      },
      key,
    );

    // record the relay this should be forwarded to
    hop.id = onion.id;
  }

  // build onion
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    await wrap(hop, i);
  }

  return onion;
}

const setup = await inquirer.prompt([
  {
    type: "input",
    name: "nsec",
    message: "Paste your nsec here",
    default: bytesToHex(generateSecretKey()),
  },
  {
    type: "select",
    name: "mint",
    message: "Select cashu mint",
    choices: ["https://mint.minibits.cash/Bitcoin", "https://stablenut.umint.cash", "https://8333.space:3338"],
  },
  {
    type: "number",
    name: "funding",
    message: "enter the amount of sats to throw away",
    min: 2,
    max: 100,
  },
]);

const nsec = normalizeNsec(setup.nsec);

const mint = new CashuMint(setup.mint);
const wallet = new CashuWallet(mint);

console.log("Getting quote from mint...");
const quote = await wallet.createMintQuote(setup.funding);

await new Promise<void>((res) => {
  qrcode.generate(quote.request, { small: true }, (code) => {
    console.log(code);
    res();
  });
});

const { paid } = await inquirer.prompt([{ type: "confirm", name: "paid", message: "Is the invoice Paid?" }]);
if (!paid) throw new Error("User is a cheapskate");

const quoteCheck = await wallet.checkMintQuote(quote.quote);
if (quoteCheck.state !== MintQuoteState.PAID) throw new Error("Failed to mint token" + quoteCheck.error);

console.log("Minting tokens...");
const { proofs } = await wallet.mintTokens(setup.funding, quote.quote);

// temp wallet
let funds = proofs;

const people = [
  {
    name: "bob",
    pubkey: getPublicKey(hexToBytes("a6b665c0cfe6d10f48500f95b81646b211dffcdc7eaaefa50faedcb93721d3f7")),
  },
  {
    name: "alice",
    pubkey: getPublicKey(hexToBytes("5ed4916b3f39303159f4ac92bc229850edca0af50ca1e24ab8c93fb577e54060")),
  },
  {
    name: "joe",
    pubkey: getPublicKey(hexToBytes("e4360db79a076da6b7c0ab3203eb64b3eea765274f09a21a1dbeb088f2005bea")),
  },
  {
    name: "frank",
    pubkey: getPublicKey(hexToBytes("efa7a3d189605b8468464e3d56202dd64885684aec7eb5a6f377bc119b98ed16")),
  },
];

// build route
const hops: Hop[] = [];

let timeout = unixNow();
while (true) {
  const remaining = funds.reduce((v, t) => v + t.amount, 0);

  const next = await inquirer.prompt([
    {
      type: "select",
      name: "pubkey",
      message: "Select a user route through",
      choices: people.map((p) => ({ name: `${p.name} (${npubEncode(p.pubkey).slice(0, 8)})`, value: p.pubkey })),
    },
    {
      type: "number",
      name: "fee",
      message: () => {
        return `how many sats? (${remaining} remaining)`;
      },
      min: 1,
      max: remaining,
      default: 1,
    },
  ]);

  const name = people.find((person) => person.pubkey === next.pubkey)?.name;
  const { inboxes } = await getUserMailboxes(next.pubkey);
  if (inboxes) console.log(`Found ${inboxes.size} inboxes for ${name}`);

  // pick a random relay
  const relay = inboxes ? Array.from(inboxes)[Math.round(Math.random() * (inboxes.size - 1))] : undefined;

  // increment the timeout by 10min + random * 5min
  timeout += Math.round(10 * 60 + 5 * 60 * Math.random());

  const { send: fee, returnChange: change } = await wallet.send(next.fee, funds);
  funds = change;

  hops.push({
    pubkey: next.pubkey,
    token: getEncodedToken({ token: [{ proofs: fee, mint: mint.mintUrl }] }),
    fee: next.fee,
    relay,
    expiration: timeout,
  });

  if (remaining - next.fee <= 0) break;

  const { another } = await inquirer.prompt([
    {
      type: "confirm",
      name: "another",
      message: () => {
        const remaining = funds.reduce((v, t) => v + t.amount, 0);
        return `Add another hop? (${remaining} sats left)`;
      },
    },
  ]);

  if (!another) break;
}

const message = await inquirer.prompt([{ type: "input", name: "content", message: "Write a short text note" }]);

// create event for publishing
const event = finalizeEvent(
  {
    kind: kinds.ShortTextNote,
    content: message.content,
    tags: [],
    created_at: unixNow(),
  },
  nsec,
);

console.log("Route:");
for (let i = 0; i < hops.length; i++) {
  const hop = hops[i];

  const name = people.find((person) => person.pubkey === hop.pubkey)?.name;
  console.log(`${i}: ${name} ${hop.relay} (${hop.fee} sats)`);
}
console.log(`${hops.length}: Publish`);

const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: "Send note?" }]);
if (!confirm) throw new Error("Abort");

// create onion
const onion = await growOnion(event, hops);

if (funds.length > 0) {
  console.log("Here are your remaining cashu tokens");
  console.log("--------------------------------------------------------------------------------");
  const token = getEncodedToken({ token: [{ proofs: funds, mint: mint.mintUrl }] });
  await new Promise<void>((res) => {
    qrcode.generate(token, { small: true }, (code) => {
      console.log(code);
      res();
    });
  });
  console.log("--------------------------------------------------------------------------------");
}

const mailboxes = await getUserMailboxes(getPublicKey(nsec));
const outboxes = mailboxes.outboxes ? Array.from(mailboxes.outboxes) : ["wss://nostrue.com"];

const routeIds = hops.reduce<string[]>((arr, hop) => [...arr, hop.id!], []);
const routeRelays = hops.reduce<string[]>((arr, hop) => [...arr, hop.relay!], []);
for (const r of outboxes) routeRelays.push(r);

// trace route
const sub = pool.subscribeMany(Array.from(new Set(routeRelays)), [{ ids: routeIds }], {
  onevent: (event) => {
    switch (event.kind) {
      case 2747:
      case 20747: {
        const p = event.tags.find((t) => t[0] === "p")?.[1];
        if (!p) return;
        const name = people.find((person) => person.pubkey === p)?.name;
        if (!name) return;
        console.log(`Onion reached ${name}`);
        break;
      }

      case kinds.ShortTextNote:
        console.log("Event Published!");
        console.log(`https://nostrudel.ninja/#/l/${neventEncode({ id: event.id, relays: outboxes })}`);

        sub.close();
        process.exit(0);
    }
  },
});

// get inboxes of first hop
console.log("Fetching relays for first hop...");
const firstHop = await getUserMailboxes(getPublicKey(nsec));

console.log("Publishing...");
if (firstHop.inboxes) {
  console.log(`Found ${firstHop.inboxes.size} relays`);
  await pool.publish(Array.from(firstHop.inboxes), onion);
} else {
  await pool.publish(["wss://nostrue.com"], onion);
}

console.log(`Published onion ${onion.id}`);
console.log("Waiting for note to be published...");
