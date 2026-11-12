#include "hc_crypto.h"

#include <sodium.h>

#include <cstring>

namespace hc {

static const char ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

bool cryptoInit() { return sodium_init() >= 0; }

std::string toB64(const uint8_t* p, size_t n) {
  std::string out;
  out.reserve((n * 4 + 2) / 3);
  size_t i = 0;
  for (; i + 2 < n; i += 3) {
    uint32_t v = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
    out += ALPHABET[v >> 18];
    out += ALPHABET[(v >> 12) & 63];
    out += ALPHABET[(v >> 6) & 63];
    out += ALPHABET[v & 63];
  }
  if (n - i == 1) {
    uint32_t v = p[i] << 16;
    out += ALPHABET[v >> 18];
    out += ALPHABET[(v >> 12) & 63];
  } else if (n - i == 2) {
    uint32_t v = (p[i] << 16) | (p[i + 1] << 8);
    out += ALPHABET[v >> 18];
    out += ALPHABET[(v >> 12) & 63];
    out += ALPHABET[(v >> 6) & 63];
  }
  return out;
}

static int b64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-' || c == '+') return 62;
  if (c == '_' || c == '/') return 63;
  return -1;
}

bool fromB64(const std::string& in, Bytes& out) {
  size_t len = in.size();
  while (len && in[len - 1] == '=') len--;
  if (len % 4 == 1) return false;
  out.clear();
  out.reserve(len * 3 / 4);
  uint32_t value = 0;
  int bits = 0;
  for (size_t i = 0; i < len; i++) {
    int v = b64Value(in[i]);
    if (v < 0) return false;
    value = (value << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((value >> bits) & 0xff);
    }
  }
  return true;
}

Bytes randomBytes(size_t n) {
  Bytes b(n);
  randombytes_buf(b.data(), n);
  return b;
}

std::string randomId(size_t bytes) { return toB64(randomBytes(bytes)); }

Bytes kdf(const char* label, const uint8_t* secret, size_t n) {
  size_t l = strlen(label);
  Bytes in(l + n);
  memcpy(in.data(), label, l);
  memcpy(in.data() + l, secret, n);
  uint8_t h[crypto_hash_sha512_BYTES];
  crypto_hash_sha512(h, in.data(), in.size());
  return Bytes(h, h + 32);
}

Bytes secretbox(const Bytes& msg, const Bytes& nonce, const Bytes& key) {
  Bytes ct(msg.size() + crypto_secretbox_MACBYTES);
  crypto_secretbox_easy(ct.data(), msg.data(), msg.size(), nonce.data(), key.data());
  return ct;
}

bool secretboxOpen(const Bytes& ct, const Bytes& nonce, const Bytes& key, Bytes& out) {
  if (ct.size() < crypto_secretbox_MACBYTES || nonce.size() != crypto_secretbox_NONCEBYTES || key.size() != crypto_secretbox_KEYBYTES) return false;
  out.resize(ct.size() - crypto_secretbox_MACBYTES);
  return crypto_secretbox_open_easy(out.data(), ct.data(), ct.size(), nonce.data(), key.data()) == 0;
}

Bytes boxBeforenm(const Bytes& theirPub, const Bytes& mySecret) {
  Bytes k(crypto_box_BEFORENMBYTES);
  if (theirPub.size() != 32 || mySecret.size() != 32 || crypto_box_beforenm(k.data(), theirPub.data(), mySecret.data()) != 0) return Bytes();
  return k;
}

bool boxOpen(const Bytes& ct, const Bytes& nonce, const Bytes& theirPub, const Bytes& mySecret, Bytes& out) {
  if (ct.size() < crypto_box_MACBYTES || nonce.size() != crypto_box_NONCEBYTES || theirPub.size() != 32 || mySecret.size() != 32) return false;
  out.resize(ct.size() - crypto_box_MACBYTES);
  return crypto_box_open_easy(out.data(), ct.data(), ct.size(), nonce.data(), theirPub.data(), mySecret.data()) == 0;
}

Bytes sign(const Bytes& msg, const Bytes& signSecret) {
  Bytes sm(msg.size() + crypto_sign_BYTES);
  unsigned long long smlen = 0;
  crypto_sign(sm.data(), &smlen, msg.data(), msg.size(), signSecret.data());
  sm.resize((size_t)smlen);
  return sm;
}

Bytes signDetached(const Bytes& msg, const Bytes& signSecret) {
  Bytes sig(crypto_sign_BYTES);
  crypto_sign_detached(sig.data(), nullptr, msg.data(), msg.size(), signSecret.data());
  return sig;
}

Bytes sha512(const Bytes& data) {
  Bytes h(crypto_hash_sha512_BYTES);
  crypto_hash_sha512(h.data(), data.data(), data.size());
  return h;
}

Bytes hmacSha512(const Bytes& key, const uint8_t* data, size_t n) {
  Bytes mac(crypto_auth_hmacsha512_BYTES);
  crypto_auth_hmacsha512_state st;
  crypto_auth_hmacsha512_init(&st, key.data(), key.size());
  crypto_auth_hmacsha512_update(&st, data, n);
  crypto_auth_hmacsha512_final(&st, mac.data());
  return mac;
}

bool signOpen(const Bytes& sm, const Bytes& signPub, Bytes& out) {
  if (sm.size() < crypto_sign_BYTES || signPub.size() != crypto_sign_PUBLICKEYBYTES) return false;
  out.resize(sm.size());
  unsigned long long mlen = 0;
  if (crypto_sign_open(out.data(), &mlen, sm.data(), sm.size(), signPub.data()) != 0) return false;
  out.resize((size_t)mlen);
  return true;
}

Identity newIdentity() {
  Identity id;
  id.boxPub.resize(crypto_box_PUBLICKEYBYTES);
  id.boxSecret.resize(crypto_box_SECRETKEYBYTES);
  crypto_box_keypair(id.boxPub.data(), id.boxSecret.data());
  id.signPub.resize(crypto_sign_PUBLICKEYBYTES);
  id.signSecret.resize(crypto_sign_SECRETKEYBYTES);
  crypto_sign_keypair(id.signPub.data(), id.signSecret.data());
  return id;
}

}  // namespace hc
