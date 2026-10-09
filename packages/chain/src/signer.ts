import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  type Account,
  bytesToHex,
  type Hex,
  hashMessage,
  hashTypedData,
  keccak256,
  type LocalAccount,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress, toAccount } from "viem/accounts";

/**
 * Signing keys that never leave a hardware-backed key store. The evaluator key is the trust
 * root of the stablecoin rail (it decides who gets every on-chain job's funds), so in live mode
 * it must be a KMS key, not a raw private key in an environment variable. A KMS returns a DER
 * ECDSA signature over a digest; `remoteAccount` turns that into an ordinary viem account.
 */
export interface DigestSigner {
  /** Short label for logs and status: never the key material. */
  readonly label: string;
  /** Uncompressed secp256k1 public key (65 bytes, 0x04 prefix). */
  publicKey(): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature over a 32-byte digest (no further hashing). */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → (r, s). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error("not a DER ECDSA signature");
  };
  const length = () => {
    let len = der[i++] as number;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | (der[i++] as number);
    }
    return len;
  };
  const integer = () => {
    expect(0x02);
    const len = length();
    const v = BigInt(bytesToHex(der.slice(i, i + len)));
    i += len;
    return v;
  };
  expect(0x30);
  length();
  const r = integer();
  const s = integer();
  return { r, s };
}

/** SubjectPublicKeyInfo (as KMS returns it) → the 65-byte uncompressed point. */
export function spkiToPublicKey(spki: Uint8Array): Uint8Array {
  const point = spki.slice(-65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error("not an uncompressed EC point");
  return point;
}

const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;

/** A viem account whose every signature is made by `signer` (one KMS call per signature). */
export async function remoteAccount(signer: DigestSigner): Promise<LocalAccount> {
  const pub = await signer.publicKey();
  const address = publicKeyToAddress(bytesToHex(pub));

  const sign = async (hash: Hex): Promise<Hex> => {
    const der = await signer.signDigest(new Uint8Array(Buffer.from(hash.slice(2), "hex")));
    const { r } = parseDerSignature(der);
    let { s } = parseDerSignature(der);
    // Ethereum only accepts the low-s form (EIP-2).
    if (s > N / 2n) s = N - s;
    for (const yParity of [0, 1] as const) {
      const signature = serializeSignature({ r: hex32(r), s: hex32(s), yParity });
      if ((await recoverAddress({ hash, signature })) === address) return signature;
    }
    throw new Error(`${signer.label}: the signature doesn't recover to ${address}`);
  };

  const account = toAccount({
    address,
    signMessage: async ({ message }) => sign(hashMessage(message)),
    signTypedData: async (typedData) => sign(hashTypedData(typedData as never)),
    signTransaction: async (tx, opts) => {
      const serializer = opts?.serializer ?? serializeTransaction;
      const signature = await sign(keccak256(await serializer(tx)));
      const { r, s, yParity } = splitSignature(signature);
      return serializer(tx, { r, s, yParity });
    },
  });
  return { ...account, sign: async ({ hash }) => sign(hash) };
}

function splitSignature(sig: Hex) {
  return {
    r: `0x${sig.slice(2, 66)}` as Hex,
    s: `0x${sig.slice(66, 130)}` as Hex,
    yParity: Number.parseInt(sig.slice(130, 132), 16) - 27,
  };
}

/** AWS KMS key spec ECC_SECG_P256K1, usage SIGN_VERIFY. Credentials from the AWS default chain. */
export class AwsKmsSigner implements DigestSigner {
  readonly label: string;
  private readonly kms: KMSClient;
  private pub?: Uint8Array;

  constructor(
    private readonly keyId: string,
    opts: { region?: string; client?: KMSClient } = {},
  ) {
    this.label = `aws-kms:${keyId.slice(-12)}`;
    this.kms = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  }

  async publicKey() {
    if (this.pub) return this.pub;
    const out = await this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (out.KeySpec !== "ECC_SECG_P256K1" || !out.PublicKey) {
      throw new Error(`${this.label}: key spec must be ECC_SECG_P256K1 (got ${out.KeySpec})`);
    }
    this.pub = spkiToPublicKey(out.PublicKey);
    return this.pub;
  }

  async signDigest(digest: Uint8Array) {
    const out = await this.kms.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!out.Signature) throw new Error(`${this.label}: KMS returned no signature`);
    return out.Signature;
  }
}

/** Where a role's key lives: a raw key (development, testnets) or a KMS key (live). */
export type KeySource = { kind: "private_key"; key: Hex } | { kind: "kms"; signer: DigestSigner };

export async function accountFrom(source: KeySource): Promise<Account> {
  return source.kind === "private_key"
    ? privateKeyToAccount(source.key)
    : remoteAccount(source.signer);
}
