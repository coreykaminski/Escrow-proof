import { secp256k1 } from "@noble/curves/secp256k1";
import type { Hex } from "viem";
import type { DigestSigner } from "../src/signer.ts";

/**
 * A local stand-in for a KMS key: same interface, same DER output (and, with `highS`, the
 * non-canonical signatures a real HSM may return half the time).
 */
export class DevDerSigner implements DigestSigner {
  readonly label = "dev-der";
  calls = 0;
  constructor(
    private readonly key: Hex,
    private readonly highS = false,
  ) {}
  async publicKey() {
    return secp256k1.getPublicKey(this.key.slice(2), false);
  }
  async signDigest(digest: Uint8Array) {
    this.calls++;
    const sig = secp256k1.sign(digest, this.key.slice(2));
    const out = this.highS ? new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s) : sig;
    return out.toDERRawBytes();
  }
}
