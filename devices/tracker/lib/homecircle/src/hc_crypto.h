// The HomeCircle primitives (docs/PROTOCOL.md) on libsodium, which ESP32
// boards ship with: secretbox and box (XSalsa20-Poly1305), Ed25519 and
// SHA-512, byte for byte the same as TweetNaCl in the app.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace hc {

using Bytes = std::vector<uint8_t>;

/** Call once before anything else. False if the library can't start. */
bool cryptoInit();

/** Unpadded base64url, as the app writes it. */
std::string toB64(const uint8_t* p, size_t n);
inline std::string toB64(const Bytes& b) { return toB64(b.data(), b.size()); }
/** base64 or base64url, padded or not. False on bad input. */
bool fromB64(const std::string& s, Bytes& out);

Bytes randomBytes(size_t n);
/** A random id like the app's: `bytes` random bytes in base64url. */
std::string randomId(size_t bytes = 16);

/** H(label ‖ secret)[0..32] with SHA-512. */
Bytes kdf(const char* label, const uint8_t* secret, size_t n);

/** secretbox: nonce (24) and key (32) bytes; returns MAC ‖ ciphertext. */
Bytes secretbox(const Bytes& msg, const Bytes& nonce, const Bytes& key);
bool secretboxOpen(const Bytes& ct, const Bytes& nonce, const Bytes& key, Bytes& out);
/** The box shared key (X25519 then HSalsa20), as nacl.box.before. */
Bytes boxBeforenm(const Bytes& theirPub, const Bytes& mySecret);
/** box open: from their box public key to my box secret key. */
bool boxOpen(const Bytes& ct, const Bytes& nonce, const Bytes& theirPub, const Bytes& mySecret, Bytes& out);

/** Ed25519 attached signature: signature ‖ message. */
Bytes sign(const Bytes& msg, const Bytes& signSecret);
/** Ed25519 detached signature (64 bytes). */
Bytes signDetached(const Bytes& msg, const Bytes& signSecret);
Bytes sha512(const Bytes& data);
/** HMAC-SHA-512 (64 bytes) with a 32-byte key. */
Bytes hmacSha512(const Bytes& key, const uint8_t* data, size_t n);
bool signOpen(const Bytes& signedMsg, const Bytes& signPub, Bytes& out);

struct Identity {
  Bytes boxPub, boxSecret, signPub, signSecret;
};
Identity newIdentity();

inline Bytes bytesOf(const std::string& s) { return Bytes(s.begin(), s.end()); }
inline std::string stringOf(const Bytes& b) { return std::string(b.begin(), b.end()); }

}  // namespace hc
