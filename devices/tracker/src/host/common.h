// What the host programs share: HTTP with libcurl, a JSON file for storage,
// and a clock the tests can move forward.
#pragma once
#include <curl/curl.h>
#include <hc_device.h>

#include <chrono>
#include <fstream>
#include <sstream>

namespace host {

inline size_t collect(char* p, size_t size, size_t n, void* out) {
  static_cast<std::string*>(out)->append(p, size * n);
  return size * n;
}

class CurlHttp : public hc::Http {
 public:
  hc::HttpResponse request(const char* method, const std::string& url, const std::string& token, const std::string& body) override {
    hc::HttpResponse res;
    CURL* c = curl_easy_init();
    if (!c) return res;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "User-Agent: homecircle-host");
    std::string auth;
    if (!token.empty()) {
      auth = "Authorization: Bearer " + token;
      headers = curl_slist_append(headers, auth.c_str());
    }
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
    curl_easy_setopt(c, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 20L);
    if (!body.empty()) {
      curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
      curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
    }
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, collect);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &res.body);
    if (curl_easy_perform(c) == CURLE_OK) {
      long code = 0;
      curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
      res.status = (int)code;
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(c);
    return res;
  }
};

// One JSON file of keys and values.
class FileStore : public hc::Store {
 public:
  explicit FileStore(std::string path) : path_(std::move(path)) {}
  bool get(const char* key, std::string& out) override {
    JsonDocument d;
    if (!read(d) || !d[key].is<const char*>()) return false;
    out = d[key].as<const char*>();
    return true;
  }
  bool put(const char* key, const std::string& value) override {
    JsonDocument d;
    read(d);
    d[key] = value;
    std::ofstream f(path_);
    serializeJson(d, f);
    return f.good();
  }
  void remove(const char* key) override {
    JsonDocument d;
    if (!read(d)) return;
    d.remove(key);
    std::ofstream f(path_);
    serializeJson(d, f);
  }

 private:
  bool read(JsonDocument& d) {
    std::ifstream f(path_);
    if (!f) return false;
    std::stringstream s;
    s << f.rdbuf();
    return !deserializeJson(d, s.str());
  }
  std::string path_;
};

// The tests can move this clock forward ("advance") to make time pass.
inline int64_t& clockOffsetMs() {
  static int64_t offset = 0;
  return offset;
}

inline int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count() + clockOffsetMs();
}

}  // namespace host
