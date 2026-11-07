# Turning on real money and Autonomi

Everything here is **off by default**. Nothing spends, charges or stores on a
paid network until you set the switches below on the machine that runs
`constellate serve`. Do test mode first: it uses Stripe test keys and USDC on
Base Sepolia, so you can try every step without real money.

Secrets go in the encrypted key vault on that machine, typed at a hidden prompt.
They are never stored in git, in records or in the browser.

```sh
constellate keys set stripe           # sk_test_… in test mode, sk_live_… in live
constellate keys set stripe-webhook   # whsec_… from the webhook you create below
```

## 1. Credit funded by card (Stripe)

1. In the Stripe Dashboard, create an API key (test mode first).
2. Add a webhook endpoint: `https://<your hub>/api/funds/stripe/webhook`, for
   the events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. Copy its signing secret.
3. Store both keys as above, and set `CONSTELLATE_PUBLIC_URL=https://<your hub>`
   so Stripe returns people to the right page.

People then choose **Add $5 / $20 / $50 → Card** on their Me page. They are
credited when Stripe's signed webhook says the payment succeeded, and only once
per payment, even if Stripe sends the webhook again. Stripe can't currently turn
a card payment into USDC on-chain, so card top-ups become credit here, and
payouts happen in USDC (below).

## 2. Credit funded by USDC from MetaMask (Base)

Set `CONSTELLATE_USDC_DEPOSIT_ADDRESS=0x…`, your MetaMask account. The page asks
the person's MetaMask to:

1. Switch to Base (or Base Sepolia in test mode).
2. Send USDC to that address.
3. Sign a free message proving the transfer came from them.

The hub reads the transaction from the chain (`CONSTELLATE_BASE_RPC`, default
the public Base RPC). It waits for 5 confirmations live (1 in test mode). It
credits the exact amount, once, to the identity that signed. USDC has six
decimals, the same unit as the app's micro-dollars.

- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (chain 8453)
- USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (chain 84532)

## 3. Paying contributors

Contributors set a payout address on their Me page. It is a record signed by
their own key, so only they can change it. Open `http://127.0.0.1:4747/#/treasury`
on the hub's own machine; the page refuses requests from anywhere else. For each
person owed at least `CONSTELLATE_MIN_PAYOUT_MICRO` (default $1), press **Pay
with MetaMask**. Once the transfer is confirmed on-chain for the full amount,
their credit is debited. The server never holds a key that can spend.

## 4. Switches

```sh
CONSTELLATE_PAYMENTS=test            # test mode: Stripe test keys, Base Sepolia
CONSTELLATE_PAYMENTS=live            # real money...
CONSTELLATE_MAINNET_APPROVED=yes     # ...only with this as well
```

A live Stripe key is refused in test mode, and a test key in live mode. Every
balance change is a line in `~/.constellate/credits-<mode>.jsonl`, an
append-only journal you can audit or replay.

## 5. Autonomi permanent storage (mainnet)

The hub talks to a local `antd` daemon, which holds the wallet and the pointer
key. Constellate holds neither.

1. Install and run `antd` for the production network, with a wallet key
   (`AUTONOMI_WALLET_KEY`) and the Arbitrum One settings: RPC
   `https://arb1.arbitrum.io/rpc`, token
   `0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684`, vault
   `0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26`. Check `antd`'s README for the
   exact flags in your version.
2. From MetaMask, send that wallet some **ANT** (for storage) and a little
   **ETH** (for gas), both on Arbitrum One.
3. Create one pointer key with `ant pointer keygen`, start antd with
   `--pointer-keys <file>`, and note the pointer's address.
4. Set:
   ```sh
   CONSTELLATE_ARCHIVE=autonomi
   CONSTELLATE_MAINNET_APPROVED=yes
   CONSTELLATE_AUTONOMI_POINTER=<pointer address>
   CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO=<most a day may cost, in atto-ANT>
   ANTD_URL=http://127.0.0.1:8082      # the default
   ```
5. Run `constellate autonomi status` to see the wallet, balances and budget,
   and whether the daemon holds the pointer key. Then run
   `constellate autonomi approve` once, to let it spend the tokens.

Every upload is priced first and refused past the daily cap, before anything
is paid. Named pointers (such as the latest summary per cluster) live in one
index object behind your one Autonomi pointer. The index is written in batches
(at most every 10 minutes), because every pointer write is paid. Writes are
never retried automatically.

## What hasn't been tested yet

These have only been tested against stand-in servers built from the official
documentation:

- Stripe's API and webhook signing
- Base's JSON-RPC
- antd's REST API
- x0x Spaces and Presence

The full flow has not yet run against the real services. Run it in test mode
first, with a few dollars of test funds, before switching to live.
