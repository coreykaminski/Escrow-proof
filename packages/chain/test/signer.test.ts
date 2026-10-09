import { GetPublicKeyCommand, type KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AwsKmsSigner, parseDerSignature, remoteAccount, spkiToPublicKey } from "../src/signer.ts";
import { DevDerSigner } from "./dev-signer.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const local = privateKeyToAccount(KEY);
const typedData = {
  domain: { name: "Test", version: "1", chainId: 84532 },
  types: { Mail: [{ name: "contents", type: "string" }] },
  primaryType: "Mail",
  message: { contents: "hi" },
} as const;

describe("remote (KMS) accounts", () => {
  for (const highS of [false, true]) {
    it(`sign exactly like the local key (${highS ? "high-s DER, normalized" : "low-s DER"})`, async () => {
      const account = await remoteAccount(new DevDerSigner(KEY, highS));
      expect(account.address).toBe(local.address);

      const msg = await account.signMessage({ message: "proof desk" });
      expect(await recoverMessageAddress({ message: "proof desk", signature: msg })).toBe(
        local.address,
      );
      // Deterministic ECDSA (RFC 6979) + low-s: byte-identical to viem's own signer.
      expect(msg).toBe(await local.signMessage({ message: "proof desk" }));

      const sig = await account.signTypedData(typedData);
      expect(await verifyTypedData({ ...typedData, address: local.address, signature: sig })).toBe(
        true,
      );

      const tx = {
        chainId: 84532,
        type: "eip1559" as const,
        to: local.address,
        value: 1n,
        nonce: 3,
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      };
      const signed = await account.signTransaction(tx);
      expect(signed).toBe(await local.signTransaction(tx));
      expect(
        await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` }),
      ).toBe(local.address);
      expect(parseTransaction(signed).nonce).toBe(3);
    });
  }

  it("parses DER, including long-form lengths and leading-zero integers", () => {
    const r = 0x80n << 248n; // high bit set → encoded with a leading 0x00
    const der = Uint8Array.from([
      0x30,
      0x81,
      0x46,
      0x02,
      0x21,
      0x00,
      0x80,
      ...new Array(31).fill(0),
      0x02,
      0x21,
      0x00,
      0xff,
      ...new Array(31).fill(1),
    ]);
    const out = parseDerSignature(der);
    expect(out.r).toBe(r);
    expect(out.s >> 248n).toBe(0xffn);
    expect(() => parseDerSignature(Uint8Array.from([0x31, 0]))).toThrow();
  });

  it("AwsKmsSigner speaks KMS: SPKI public key, DIGEST signing, key spec check", async () => {
    const dev = new DevDerSigner(KEY);
    const point = await dev.publicKey();
    // secp256k1 SubjectPublicKeyInfo header + the uncompressed point.
    const spki = Uint8Array.from([
      ...Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"),
      ...point,
    ]);
    expect(spkiToPublicKey(spki)).toEqual(point);
    const sent: unknown[] = [];
    const client = {
      async send(cmd: unknown) {
        sent.push(cmd);
        if (cmd instanceof GetPublicKeyCommand)
          return { KeySpec: "ECC_SECG_P256K1", PublicKey: spki };
        if (cmd instanceof SignCommand) {
          expect(cmd.input).toMatchObject({
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
          });
          return { Signature: await dev.signDigest(cmd.input.Message as Uint8Array) };
        }
        throw new Error("unexpected command");
      },
    } as unknown as KMSClient;
    const account = await remoteAccount(
      new AwsKmsSigner("arn:aws:kms:us-east-1:1:key/abc", { client }),
    );
    expect(account.address).toBe(local.address);
    expect(await account.signMessage({ message: "x" })).toBe(
      await local.signMessage({ message: "x" }),
    );

    const wrong = {
      async send() {
        return { KeySpec: "ECC_NIST_P256", PublicKey: spki };
      },
    } as unknown as KMSClient;
    await expect(remoteAccount(new AwsKmsSigner("k", { client: wrong }))).rejects.toThrow(
      "ECC_SECG_P256K1",
    );
  });
});
