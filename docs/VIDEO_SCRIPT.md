# 3-minute video script (draft)

Goal: show the Arc Studio build AND a real mainnet call. Record the screen, talk over it, no music needed. About 150 words a minute, so the spoken text below is about 400 words.

Before recording: have the mainnet contract address, a funded mainnet wallet (a few dollars), the Arc Studio project open in one tab, the live site (www.kairomarkets.xyz) in another, and explorer.arc.io ready. Do one dry run on the real site first. Nothing in brackets is invented: fill it from what actually exists.

| Time | Show | Say |
|---|---|---|
| 0:00 to 0:15 | The site home on a phone-width window. | "This is Kairo Markets, at kairomarkets dot x-y-z. You call the next move of Bitcoin, Ethereum or Solana, up or down, with a few dollars of USDC on Arc." |
| 0:15 to 0:40 | The "How it works" page, the one-line rule. | "Only matched money plays. Your money plays against the other side. If one side has more, the extra comes back. Winners double the money that played, minus two percent." |
| 0:40 to 1:20 | Arc Studio project page: the contract, the chat history, the test run. Scroll slowly. | "I built the contract in Arc Studio. Here is the project. This is where it wrote the contract and ran the tests. [SAY ONLY WHAT IS TRUE: for example, how many tests Arc Studio ran, and which parts of the app it built.] More tests and deliberate-break checks run on GitHub for every change." |
| 1:20 to 1:40 | Explorer page of the mainnet contract. | "The contract is live on Arc mainnet at this address. [Read the first and last 4 characters.] Anyone can read it here." |
| 1:40 to 2:30 | The live site, connect the wallet, pick BTC, pick UP, $0.50 or $1, confirm in the wallet. Show the wallet pop-up and the "Your call is live" bar. | "Now a real call on mainnet. I connect my wallet, choose Bitcoin, choose UP, and put in [amount]. The wallet asks me to confirm. The fee is paid in USDC too, so I need nothing else." |
| 2:30 to 2:50 | The receipt: Matched row, then the transaction link, then explorer.arc.io showing the transaction. | "Here is the call on the chain: this transaction. The receipt shows how much of my money is matched, and what I win or get back." |
| 2:50 to 3:00 | The agents row and the Back this agent button. | "Four agents make calls too, and you can back one. That is Kairo Markets. Thank you." |

## If something is not ready on the day
- No finished round in time: show the call, the transaction and the "Your call is live" bar. Say the round is still running. Do not fake a result.
- A claim is a nice extra: if a round ends during the recording, show "Claim" and the second transaction.
- Never show a private key, a seed phrase, the `.env` file, or the Circle console.
