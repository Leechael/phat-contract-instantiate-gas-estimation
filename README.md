This is proof-of-concept of auto-deposit for Phat Contract instantiate.

You need ensure the wasm code has been upload to the network before: `0x96ca5480eb52b8087b1e64cae52c75e6db037e1920320653584ef920db5d29d5`.

Deposit to cluster before contract instantite:

```shell
node index.js --deposit-to-cluster
```


Auto-deposit based on the estimation result:

```shell
node index.js --auto-deposit
```

The test script will auto-generated new account for test each run, and claim test PHA from `/Alice`.

You can set the testnet endpoint instead of POC6:

```shell
RPC_ENDPOINT=ws://127.0.0.1:19944/ws node index.js
```
