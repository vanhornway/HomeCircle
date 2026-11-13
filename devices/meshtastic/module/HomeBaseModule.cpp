// SPDX-License-Identifier: GPL-3.0-only
// HomeCircle home base for Meshtastic. The home base's logic (trackers,
// admins' commands, quiet phones, SOS) is hc::HomeBase in the tracker
// library, copied in by build.sh; this file connects it to the node:
//
// - a setup page on the node's own Wi-Fi the first time: home Wi-Fi, the
//   invite link (which also names the server) and the LoRa region;
// - the private HomeCircle channel, and the link that puts trackers on it,
//   on this node's frequency so other people's nodes still relay;
// - trackers' positions and battery from the node database, their texts,
//   and position requests over the mesh.
#include "HomeBaseModule.h"
#ifdef HOMECIRCLE_HOMEBASE

// Meshtastic's headers first: ArduinoJson (in the HomeCircle headers) brings
// its own Allocator into the global namespace, which clashes with Meshtastic's.
#include "Channels.h"
#include "MeshRadio.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "PowerStatus.h"
#include "airtime.h"
#include "main.h"
#include "mesh/generated/meshtastic/admin.pb.h"
#include "mesh/generated/meshtastic/apponly.pb.h"
#include "mesh/mesh-pb-constants.h"
#if !MESHTASTIC_EXCLUDE_GPS
#include "gps/GPS.h"
#include "mqtt/MQTT.h"
#endif
// clang-format off
#include "HomeCircleIO.h"
#include "homecircle/hc_homebase.h"
// clang-format on
#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#include <algorithm>
#include <map>
#include <math.h>
#include <sodium.h>

extern uint32_t hash(const char *str); // RadioInterface.cpp: how Meshtastic picks a frequency slot from a name

HomeBaseModule *homeBaseModule;

// Meshtastic runs everything, this module included, in Arduino's loop task,
// which gets 8 KB of stack by default. An HTTPS handshake (mbedTLS) inside a
// home base command doesn't fit in that: it overflowed while adding a tracker.
SET_LOOP_TASK_STACK_SIZE(24 * 1024);

namespace
{

const char *CHANNEL = "HomeCircle";
const uint32_t PORTAL_MS = 30 * 60 * 1000;

bool startConfig(uint32_t node, const hc::TrackerConfig &c);
void sendKeyTo(uint32_t node);

struct MeshRadio : hc::Radio {
    bool configure(uint32_t node, const hc::TrackerConfig &c) override { return startConfig(node, c); }
    void introduce(uint32_t node) override { sendKeyTo(node); }
    bool nodePosition(uint32_t node, double &lat, double &lng) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
        if (!n || !n->has_position || (!n->position.latitude_i && !n->position.longitude_i))
            return false;
        lat = n->position.latitude_i * 1e-7;
        lng = n->position.longitude_i * 1e-7;
        return true;
    }
    uint32_t selfNode() override { return nodeDB->getNodeNum(); }
    void favorite(uint32_t node) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
        if (n && !n->is_favorite)
            nodeDB->set_favorite(true, node);
    }
    void addContact(const hc::Bytes &raw) override
    {
        meshtastic_SharedContact c = meshtastic_SharedContact_init_zero;
        if (pb_decode_from_bytes(raw.data(), raw.size(), &meshtastic_SharedContact_msg, &c) && c.node_num && c.has_user) {
            nodeDB->addFromContact(c);
            LOG_INFO("HomeCircle home base: added %08x from its contact", (unsigned)c.node_num);
        }
    }
    std::string publicKey() override
    {
        if (config.security.public_key.size != 32)
            return "";
        char out[64];
        sodium_bin2base64(out, sizeof out, config.security.public_key.bytes, 32, sodium_base64_VARIANT_ORIGINAL);
        return out;
    }
    void requestPosition(uint32_t node) override
    {
        if (homeBaseModule)
            homeBaseModule->askPosition(node);
    }
    void nodes(std::vector<hc::HeardNode> &out) override
    {
        uint32_t now = getTime();
        for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
            meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
            if (!n || n->num == nodeDB->getNodeNum() || !n->last_heard || now - n->last_heard > 2 * 3600)
                continue;
            hc::HeardNode h;
            h.num = n->num;
            if (n->has_user)
                h.name = n->user.long_name;
            h.heardAtMs = (int64_t)n->last_heard * 1000;
            h.snr = n->snr;
            if (n->has_device_metrics) {
                if (n->device_metrics.has_battery_level)
                    h.battery = (int)n->device_metrics.battery_level;
                if (n->device_metrics.has_voltage && n->device_metrics.voltage > 0)
                    h.volts = n->device_metrics.voltage;
            }
            out.push_back(h);
        }
    }
    bool selfInfo(hc::SelfInfo &out) override
    {
        if (powerStatus) {
            if (powerStatus->getHasBattery()) {
                out.battery = powerStatus->getBatteryChargePercent();
                if (powerStatus->getBatteryVoltageMv() > 0)
                    out.volts = powerStatus->getBatteryVoltageMv() / 1000.0f;
            }
            out.plugged = powerStatus->getHasUSB() || !powerStatus->getHasBattery();
        }
        if (WiFi.status() == WL_CONNECTED)
            out.wifiRssi = WiFi.RSSI();
        out.uptimeS = millis() / 1000;
        out.heapKb = (int)(ESP.getFreeHeap() / 1024);
        if (airTime) {
            out.chUtil = airTime->channelUtilizationPercent();
            out.airTx = airTime->utilizationTXPercent();
        }
        if (moduleConfig.mqtt.enabled)
            out.mqtt = mqtt && mqtt->isConnectedDirectly() ? 1 : 0;
        return true;
    }
    // The internet bridge: Meshtastic's MQTT module, for the private HomeCircle
    // channel only, both ways, encrypted (the broker sees only ciphertext).
    // Every HomeCircle gateway uses the same broker and root topic, so a
    // tracker one of them hears reaches this home base as if over the radio.
    bool setMqtt(const hc::MqttSettings &m) override
    {
        if (!homeBaseModule)
            return false;
        int idx = homeBaseModule->channelIndex();
        if (idx < 0)
            return false;
        meshtastic_ModuleConfig_MQTTConfig &c = moduleConfig.mqtt;
        c.enabled = m.on;
        if (m.on) {
            std::string address = m.host + ":" + std::to_string(m.port);
            strncpy(c.address, address.c_str(), sizeof c.address - 1);
            c.address[sizeof c.address - 1] = 0;
            strncpy(c.username, m.user.c_str(), sizeof c.username - 1);
            c.username[sizeof c.username - 1] = 0;
            strncpy(c.password, m.pass.c_str(), sizeof c.password - 1);
            c.password[sizeof c.password - 1] = 0;
            strncpy(c.root, "msh/homecircle", sizeof c.root - 1);
            c.root[sizeof c.root - 1] = 0;
            c.encryption_enabled = true;
            c.json_enabled = false;
            c.tls_enabled = m.port != 1883;
            c.proxy_to_client_enabled = false;
            c.map_reporting_enabled = false;
        }
        // Only the private channel goes over the bridge.
        for (int i = 0; i < MAX_NUM_CHANNELS; i++) {
            meshtastic_Channel &ch = channels.getByIndex(i);
            if (ch.role == meshtastic_Channel_Role_DISABLED)
                continue;
            ch.settings.uplink_enabled = m.on && i == idx;
            ch.settings.downlink_enabled = m.on && i == idx;
        }
        nodeDB->saveToDisk(SEGMENT_MODULECONFIG | SEGMENT_CHANNELS);
        LOG_INFO("HomeCircle home base: internet bridge %s; restarting", m.on ? "on" : "off");
        rebootAtMsec = millis() + 3000; // MQTT starts at boot
        return true;
    }
    std::string mqttHost() override
    {
        if (!moduleConfig.mqtt.enabled)
            return "";
        std::string a = moduleConfig.mqtt.address;
        size_t colon = a.rfind(':');
        return colon == std::string::npos ? a : a.substr(0, colon);
    }
    std::string channelLink() override { return homeBaseModule ? homeBaseModule->channelLink() : ""; }
    void alert(uint32_t node, const std::string &text) override
    {
        if (homeBaseModule)
            homeBaseModule->textNode(node, text);
    }
    void sosAck(uint32_t node) override
    {
        if (homeBaseModule)
            homeBaseModule->broadcastPrivate("#sos-ack " + hc::nodeId(node));
    }
    void trackerCfg(uint32_t node, const std::string &cfg) override
    {
        if (homeBaseModule)
            homeBaseModule->broadcastPrivate("#cfg " + hc::nodeId(node) + " " + cfg);
    }
    void traceroute(uint32_t node) override
    {
        if (homeBaseModule)
            homeBaseModule->traceNode(node);
    }
    std::string nodeName(uint32_t num) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(num);
        return n && n->has_user ? n->user.long_name : "";
    }
    int hopsAway(uint32_t node) override
    {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
        return n && n->has_hops_away ? n->hops_away : -1;
    }

    // This node's own GPS (the Heltec V4 takes a GNSS module), from Meshtastic's latest local position.
    hc::GnssSky skyView;
    bool selfGnss(hc::SelfGnss &out) override
    {
#if !MESHTASTIC_EXCLUDE_GPS
        out.present = gps != nullptr || config.position.fixed_position;
#else
        out.present = config.position.fixed_position;
#endif
        const meshtastic_Position &p = localPosition;
        out.hasFix = p.latitude_i || p.longitude_i;
        if (!out.present || !out.hasFix)
            return out.present;
        out.lat = p.latitude_i * 1e-7;
        out.lng = p.longitude_i * 1e-7;
        out.altitudeM = (float)p.altitude;
        out.fixAtMs = (int64_t)(p.time ? p.time : p.timestamp) * 1000;
        out.fixType = (int)p.fix_type;
        out.satsUsed = (int)p.sats_in_view;
        out.hdop = p.HDOP ? p.HDOP / 100.0f : (p.PDOP ? p.PDOP / 100.0f : -1);
        if (p.gps_accuracy && out.hdop > 0)
            out.accuracyM = p.gps_accuracy * out.hdop / 1000.0f;
        return true;
    }
    const hc::GnssSky *sky() override { return &skyView; }
};

hcio::FsStore store;
hcio::WifiHttp http;
MeshRadio radio;
hc::HomeBase hb(http, store, hcio::nowMs, radio);

// --- updates over Wi-Fi ---------------------------------------------------------------
//
// The flash has two app slots (default_16MB.csv: app0 and app1, 6.25 MB each).
// An admin's signed "update <link> <sha256>" (the app sends it) has this node
// download the new firmware into the slot it isn't running from, check its
// SHA-256 and that it's a whole ESP32 image, switch to it and restart. The
// checksum comes from the admin's message, not the download, so the file can
// come from anywhere (a GitHub release).
//
// If the new firmware restarts 3 times without its status reaching the
// server, the node goes back to the slot it came from: a bad update can't
// leave a home base on a roof unreachable. Kept in NVS ("hc-ota").
namespace ota
{
const char *NS = "hc-ota";

// Early in boot: count this start, and go back if the new firmware keeps restarting.
void checkBoot()
{
    Preferences p;
    if (!p.begin(NS, false))
        return;
    if (p.getBool("pending", false)) {
        int tries = p.getInt("tries", 0) + 1;
        p.putInt("tries", tries);
        if (tries > 3) {
            String prev = p.getString("prev", "");
            p.putBool("pending", false);
            p.putString("news", "⚠️ The update didn't start properly (it kept restarting), so I went back to the firmware I had.");
            p.end();
            const esp_partition_t *back = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, prev.c_str());
            if (back && esp_ota_set_boot_partition(back) == ESP_OK) {
                LOG_WARN("HomeCircle home base: the update kept restarting; back to %s", prev.c_str());
                delay(200);
                ESP.restart();
            }
            return;
        }
    }
    p.end();
}

// Once the status has reached the server: the update worked. Says so to whoever asked.
void confirm()
{
    Preferences p;
    if (!p.begin(NS, false))
        return;
    std::string to = p.getString("by", "").c_str();
    std::string news = p.getString("news", "").c_str();
    if (p.getBool("pending", false)) {
        p.putBool("pending", false);
        p.putInt("tries", 0);
        news = std::string("✓ Updated: now running ") + HC_FW_VERSION + ".";
    }
    p.remove("news");
    p.end();
    if (!news.empty())
        hb.updateNews(to, news);
}

static uint8_t buf[4096];

// "" when it's written and switched to; otherwise what went wrong.
std::string install(const hc::HomeBase::Update &u)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target || target == running)
        return "this board has no second app slot";
    WiFiClientSecure tls;
    tls.setInsecure(); // the SHA-256 from the admin's signed message is what's checked
    HTTPClient h;
    h.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS); // GitHub release links redirect to its file host
    h.setTimeout(20000);
    if (!h.begin(tls, u.url.c_str()))
        return "that link doesn't work";
    h.addHeader("User-Agent", "homecircle-meshtastic");
    hcio::feedWatchdog();
    int code = h.GET();
    if (code != 200) {
        h.end();
        return "the download failed (HTTP " + std::to_string(code) + ")";
    }
    int len = h.getSize();
    if (len > 0 && (size_t)len > target->size) {
        h.end();
        return "the file is too big for the app slot";
    }
    esp_ota_handle_t handle;
    if (esp_ota_begin(target, OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
        h.end();
        return "couldn't start writing the update";
    }
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);
    WiFiClient *s = h.getStreamPtr();
    size_t got = 0;
    uint32_t lastData = millis();
    std::string err;
    while (len < 0 || got < (size_t)len) {
        size_t avail = s->available();
        if (!avail) {
            if (!h.connected() || millis() - lastData > 20000)
                break;
            delay(5);
            continue;
        }
        int n = s->readBytes(buf, std::min(avail, sizeof buf));
        if (n <= 0)
            continue;
        mbedtls_sha256_update(&sha, buf, n);
        if (esp_ota_write(handle, buf, n) != ESP_OK) {
            err = "writing the update failed";
            break;
        }
        got += n;
        lastData = millis();
        hcio::feedWatchdog();
    }
    h.end();
    uint8_t digest[32];
    mbedtls_sha256_finish(&sha, digest);
    mbedtls_sha256_free(&sha);
    char hex[65];
    for (int i = 0; i < 32; i++)
        snprintf(hex + i * 2, 3, "%02x", digest[i]);
    if (err.empty() && len > 0 && got != (size_t)len)
        err = "the download stopped part way (" + std::to_string(got) + " of " + std::to_string(len) + " bytes)";
    if (err.empty() && u.sha256 != hex)
        err = "the file's checksum didn't match, so I didn't use it";
    if (!err.empty()) {
        esp_ota_abort(handle);
        return err;
    }
    if (esp_ota_end(handle) != ESP_OK) // checks it's a whole image for this chip
        return "that isn't a firmware image for this board";
    esp_app_desc_t desc;
    if (esp_ota_get_partition_description(target, &desc) == ESP_OK)
        LOG_INFO("HomeCircle home base: update %s (%s) written to %s", desc.version, desc.project_name, target->label);
    Preferences p;
    p.begin(NS, false);
    p.putBool("pending", true);
    p.putInt("tries", 0);
    p.putString("prev", running->label);
    p.putString("by", u.by.c_str());
    p.end();
    if (esp_ota_set_boot_partition(target) != ESP_OK) {
        p.begin(NS, false);
        p.putBool("pending", false);
        p.end();
        return "couldn't switch to the update";
    }
    return "";
}
} // namespace ota

// --- settings onto a tracker (Meshtastic remote admin) ---------------------------------
//
// The tracker must list this node's public key as an admin key. Then: ask for
// its device, position, telemetry and alert settings (the answers carry a
// session key), change what HomeCircle manages, and send them back inside one
// edit; the tracker's acknowledgement of the commit means they're on it.
struct ConfigJob {
    hc::TrackerConfig want;
    uint32_t startedAt = 0;
    uint32_t askAt = 0; // when to ask for its settings (after it has had time to learn our key)
    bool asked = false;
    uint32_t askedAt = 0;
    int reasks = 0;
    uint32_t sentAt = 0;
    int checks = 0; // read-backs of its position settings after sending them
    uint8_t passkey[8];
    bool havePass = false, sent = false;
    bool haveDevice = false, havePosition = false, haveTelemetry = false, haveAlerts = false, haveLora = false;
    meshtastic_Config_LoRaConfig lora;
    meshtastic_Config_DeviceConfig device;
    meshtastic_Config_PositionConfig position;
    meshtastic_ModuleConfig_TelemetryConfig telemetry;
    meshtastic_ModuleConfig_ExternalNotificationConfig alerts;
    std::vector<uint32_t> ids; // our packets to it, for its error answers
    uint32_t commitId = 0;
};
std::map<uint32_t, ConfigJob> configJobs;
const uint32_t CONFIG_TIMEOUT_MS = 300 * 1000;
const uint32_t KEY_FIRST_MS = 15 * 1000;

uint32_t sendAdmin(uint32_t node, meshtastic_AdminMessage &m, bool wantResponse, bool wantAck)
{
    meshtastic_MeshPacket *p = router->allocForSending();
    p->to = node;
    p->decoded.portnum = meshtastic_PortNum_ADMIN_APP;
    p->decoded.want_response = wantResponse;
    p->want_ack = wantAck;
    p->pki_encrypted = true; // only a tracker that trusts this node's key acts on it
    p->channel = 0;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    p->decoded.payload.size = pb_encode_to_bytes(p->decoded.payload.bytes, sizeof(p->decoded.payload.bytes), &meshtastic_AdminMessage_msg, &m);
    uint32_t id = p->id;
    service->sendToMesh(p);
    return id;
}

void askSettings(uint32_t node, ConfigJob &job);

// This node's user (its key included) straight to one node on the private
// channel. Built here rather than with NodeInfoModule::sendOurNodeInfo, which
// sends at most one node info every 10 minutes: a second tracker would miss it.
void sendKeyTo(uint32_t node)
{
    int idx = homeBaseModule ? homeBaseModule->channelIndex() : -1;
    meshtastic_MeshPacket *info = router->allocForSending();
    info->to = node;
    info->channel = idx >= 0 ? idx : channels.getPrimaryIndex();
    info->decoded.portnum = meshtastic_PortNum_NODEINFO_APP;
    info->decoded.want_response = false;
    info->want_ack = false;
    info->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    meshtastic_User me = owner;
    strcpy(me.id, nodeDB->getNodeId().c_str());
    info->decoded.payload.size = pb_encode_to_bytes(info->decoded.payload.bytes, sizeof(info->decoded.payload.bytes), &meshtastic_User_msg, &me);
    service->sendToMesh(info);
    LOG_INFO("HomeCircle home base: sent %08x this node's key", (unsigned)node);
}

bool startConfig(uint32_t node, const hc::TrackerConfig &c)
{
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    if (!n || n->user.public_key.size != 32)
        return false; // its key comes with its node info: wait until it has been heard
    ConfigJob &job = configJobs[node];
    job = ConfigJob();
    job.want = c;
    job.startedAt = millis();
    // Admin messages are encrypted from this node's key to the tracker's: the
    // tracker can only open them if it knows our key, which comes with our
    // node info. Ours goes out on the public channel, which a tracker on the
    // private one doesn't hear, so send it straight to the tracker first.
    sendKeyTo(node);
    job.askAt = millis() + KEY_FIRST_MS;
    LOG_INFO("HomeCircle home base: sent %08x this node's key; asking for its settings shortly", (unsigned)node);
    return true;
}

// Asks for whichever of its four settings haven't come back yet.
void askSettings(uint32_t node, ConfigJob &job)
{
    job.asked = true;
    job.askedAt = millis();
    meshtastic_AdminMessage m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_get_config_request_tag;
    if (!job.haveDevice) {
        m.get_config_request = meshtastic_AdminMessage_ConfigType_DEVICE_CONFIG;
        job.ids.push_back(sendAdmin(node, m, true, false));
    }
    if (!job.havePosition) {
        m.get_config_request = meshtastic_AdminMessage_ConfigType_POSITION_CONFIG;
        job.ids.push_back(sendAdmin(node, m, true, false));
    }
    if (!job.haveLora) {
        m.get_config_request = meshtastic_AdminMessage_ConfigType_LORA_CONFIG;
        job.ids.push_back(sendAdmin(node, m, true, false));
    }
    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_get_module_config_request_tag;
    if (!job.haveTelemetry) {
        m.get_module_config_request = meshtastic_AdminMessage_ModuleConfigType_TELEMETRY_CONFIG;
        job.ids.push_back(sendAdmin(node, m, true, false));
    }
    if (!job.haveAlerts) {
        m.get_module_config_request = meshtastic_AdminMessage_ModuleConfigType_EXTNOTIF_CONFIG;
        job.ids.push_back(sendAdmin(node, m, true, false));
    }
    LOG_INFO("HomeCircle home base: reading %08x's settings", (unsigned)node);
}

void sendConfig(uint32_t node, ConfigJob &job)
{
    job.sent = true;
    auto withKey = [&](meshtastic_AdminMessage &m) {
        m.session_passkey.size = 8;
        memcpy(m.session_passkey.bytes, job.passkey, 8);
    };
    // What HomeCircle manages; everything else stays as it was on the tracker.
    job.device.disable_triple_click = true; // 3 presses mean "come pick me up", not "GPS off"
    job.position.gps_mode = meshtastic_Config_PositionConfig_GpsMode_ENABLED;
    job.position.position_broadcast_smart_enabled = true;
    job.position.broadcast_smart_minimum_interval_secs = job.want.movingS;
    if (!job.position.broadcast_smart_minimum_distance)
        job.position.broadcast_smart_minimum_distance = 100;
    job.position.position_broadcast_secs = job.want.stillS;
    job.telemetry.device_telemetry_enabled = job.want.batteryS > 0;
    job.telemetry.device_update_interval = job.want.batteryS > 0 ? job.want.batteryS : 0;
    job.alerts.enabled = true;
    job.alerts.alert_bell_buzzer = true; // a text with the bell (Chirp, Ask to check in) beeps

    meshtastic_AdminMessage m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_begin_edit_settings_tag;
    m.begin_edit_settings = true;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_config_tag;
    m.set_config.which_payload_variant = meshtastic_Config_device_tag;
    m.set_config.payload_variant.device = job.device;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_config_tag;
    m.set_config.which_payload_variant = meshtastic_Config_position_tag;
    m.set_config.payload_variant.position = job.position;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    // More relays allowed on the way home: a tracker far from home still reaches it.
    job.lora.hop_limit = job.want.hopLimit;
    // OK for gateways to pass its packets on over the internet bridge (MQTT):
    // a gateway on a public broker skips other nodes' packets without it.
    job.lora.config_ok_to_mqtt = job.want.okToMqtt;
    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_config_tag;
    m.set_config.which_payload_variant = meshtastic_Config_lora_tag;
    m.set_config.payload_variant.lora = job.lora;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_module_config_tag;
    m.set_module_config.which_payload_variant = meshtastic_ModuleConfig_telemetry_tag;
    m.set_module_config.payload_variant.telemetry = job.telemetry;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_module_config_tag;
    m.set_module_config.which_payload_variant = meshtastic_ModuleConfig_external_notification_tag;
    m.set_module_config.payload_variant.external_notification = job.alerts;
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_set_favorite_node_tag;
    m.set_favorite_node = nodeDB->getNodeNum(); // the home base: it keeps our key and route
    withKey(m);
    job.ids.push_back(sendAdmin(node, m, false, false));

    m = meshtastic_AdminMessage_init_zero;
    m.which_payload_variant = meshtastic_AdminMessage_commit_edit_settings_tag;
    m.commit_edit_settings = true;
    withKey(m);
    job.commitId = sendAdmin(node, m, false, true); // its acknowledgement means the settings are on it
    job.ids.push_back(job.commitId);
    job.sentAt = millis();
    LOG_INFO("HomeCircle home base: sent %08x its settings", (unsigned)node);
}

// An admin answer from a tracker we're setting up.
void configAnswer(const meshtastic_MeshPacket &mp)
{
    auto it = configJobs.find(mp.from);
    if (it == configJobs.end() || !it->second.asked)
        return;
    ConfigJob &job = it->second;
    meshtastic_AdminMessage r = meshtastic_AdminMessage_init_zero;
    if (!pb_decode_from_bytes(mp.decoded.payload.bytes, mp.decoded.payload.size, &meshtastic_AdminMessage_msg, &r))
        return;
    if (job.sent) {
        if (r.which_payload_variant == meshtastic_AdminMessage_get_config_response_tag &&
            r.get_config_response.which_payload_variant == meshtastic_Config_position_tag) {
            const meshtastic_Config_PositionConfig &pos = r.get_config_response.payload_variant.position;
            if (pos.position_broadcast_secs == (uint32_t)job.want.stillS &&
                pos.broadcast_smart_minimum_interval_secs == (uint32_t)job.want.movingS) {
                LOG_INFO("HomeCircle home base: %08x has its settings (read back)", (unsigned)mp.from);
                configJobs.erase(it);
                hb.onConfigured(mp.from, hc::ConfigResult::Set);
            }
        }
        return;
    }
    if (r.session_passkey.size == 8) {
        memcpy(job.passkey, r.session_passkey.bytes, 8);
        job.havePass = true;
    }
    if (r.which_payload_variant == meshtastic_AdminMessage_get_config_response_tag) {
        if (r.get_config_response.which_payload_variant == meshtastic_Config_device_tag) {
            job.device = r.get_config_response.payload_variant.device;
            job.haveDevice = true;
        } else if (r.get_config_response.which_payload_variant == meshtastic_Config_position_tag) {
            job.position = r.get_config_response.payload_variant.position;
            job.havePosition = true;
        } else if (r.get_config_response.which_payload_variant == meshtastic_Config_lora_tag) {
            job.lora = r.get_config_response.payload_variant.lora;
            job.haveLora = true;
        }
    } else if (r.which_payload_variant == meshtastic_AdminMessage_get_module_config_response_tag) {
        if (r.get_module_config_response.which_payload_variant == meshtastic_ModuleConfig_telemetry_tag) {
            job.telemetry = r.get_module_config_response.payload_variant.telemetry;
            job.haveTelemetry = true;
        } else if (r.get_module_config_response.which_payload_variant == meshtastic_ModuleConfig_external_notification_tag) {
            job.alerts = r.get_module_config_response.payload_variant.external_notification;
            job.haveAlerts = true;
        }
    }
    LOG_INFO("HomeCircle home base: %08x answered (variant %d): key %d device %d position %d telemetry %d alerts %d lora %d", (unsigned)mp.from,
             (int)r.which_payload_variant, job.havePass, job.haveDevice, job.havePosition, job.haveTelemetry, job.haveAlerts, job.haveLora);
    if (job.havePass && job.haveDevice && job.havePosition && job.haveTelemetry && job.haveAlerts && job.haveLora)
        sendConfig(mp.from, job);
}

// A routing answer from a tracker: our commit acknowledged, or one of our admin packets refused.
void configRouting(const meshtastic_MeshPacket &mp)
{
    auto it = configJobs.find(mp.from);
    if (it == configJobs.end() || !mp.decoded.request_id)
        return;
    ConfigJob &job = it->second;
    if (std::find(job.ids.begin(), job.ids.end(), mp.decoded.request_id) == job.ids.end())
        return;
    meshtastic_Routing r = meshtastic_Routing_init_zero;
    if (!pb_decode_from_bytes(mp.decoded.payload.bytes, mp.decoded.payload.size, &meshtastic_Routing_msg, &r))
        return;
    meshtastic_Routing_Error e = r.which_variant == meshtastic_Routing_error_reason_tag ? r.error_reason : meshtastic_Routing_Error_NONE;
    LOG_INFO("HomeCircle home base: %08x routing answer %d to one of our settings packets", (unsigned)mp.from, (int)e);
    if (e == meshtastic_Routing_Error_ADMIN_PUBLIC_KEY_UNAUTHORIZED || e == meshtastic_Routing_Error_NOT_AUTHORIZED) {
        LOG_INFO("HomeCircle home base: %08x doesn't have the home base's key as an admin key", (unsigned)mp.from);
        configJobs.erase(it);
        hb.onConfigured(mp.from, hc::ConfigResult::NeedsKey);
    } else if (e != meshtastic_Routing_Error_NONE) {
        LOG_INFO("HomeCircle home base: %08x refused its settings (error %d)", (unsigned)mp.from, (int)e);
        configJobs.erase(it);
        hb.onConfigured(mp.from, hc::ConfigResult::Failed);
    } else if (mp.decoded.request_id == job.commitId) {
        LOG_INFO("HomeCircle home base: %08x has its settings", (unsigned)mp.from);
        configJobs.erase(it);
        hb.onConfigured(mp.from, hc::ConfigResult::Set);
    }
}

void configTimeouts()
{
    for (auto it = configJobs.begin(); it != configJobs.end();) {
        ConfigJob &job = it->second;
        if (!job.asked && (int32_t)(millis() - job.askAt) >= 0)
            askSettings(it->first, job);
        else if (job.asked && !job.sent && job.reasks < 2 && millis() - job.askedAt > 25 * 1000) {
            job.reasks++; // some answers didn't come: ask for those again
            askSettings(it->first, job);
        } else if (job.sent && job.checks < 3 && millis() - job.sentAt > (uint32_t)(40 + 30 * job.checks) * 1000) {
            // No acknowledgement yet: read its position settings back instead.
            job.checks++;
            meshtastic_AdminMessage m = meshtastic_AdminMessage_init_zero;
            m.which_payload_variant = meshtastic_AdminMessage_get_config_request_tag;
            m.get_config_request = meshtastic_AdminMessage_ConfigType_POSITION_CONFIG;
            job.ids.push_back(sendAdmin(it->first, m, true, false));
        }
        if (millis() - it->second.startedAt > CONFIG_TIMEOUT_MS) {
            uint32_t node = it->first;
            it = configJobs.erase(it);
            hb.onConfigured(node, hc::ConfigResult::Failed);
        } else {
            ++it;
        }
    }
}

bool started = false;
bool configured = false; // in a circle, with home Wi-Fi: doing its job
bool needInvite = true;  // the setup page asks for an invite (not yet in a circle), or only for Wi-Fi
uint32_t lastTick = 0, lastPoll = 0;
bool updateConfirmed = false; // after a start: told whoever asked for an update how it went
std::map<uint32_t, uint32_t> seenFix; // node -> the position time last passed on

// --- the setup page ---
DNSServer *dns = nullptr;
WebServer *web = nullptr;
uint32_t portalStarted = 0;
enum class Job { None, Joining, Joined, Failed };
Job job = Job::None;
std::string jobError, wifiSsid, wifiPass, invite;
int region = 0;
uint32_t joinedAt = 0;
String apSsid, apPass;

String deviceSuffix()
{
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac);
    char s[5];
    snprintf(s, sizeof s, "%02X%02X", mac[4], mac[5]);
    return s;
}

// The setup network's password: from the chip, so it's the same every time. Shown on the screen.
String apPassword()
{
    uint8_t mac[6], h[32];
    esp_efuse_mac_get_default(mac);
    uint8_t in[14] = {'h', 'c', '-', 'h', 'b', '-', 'v', '1'};
    memcpy(in + 8, mac, 6);
    crypto_hash_sha256(h, in, sizeof in);
    static const char *A = "23456789abcdefghjkmnpqrstuvwxyz";
    String p;
    for (int i = 0; i < 10; i++)
        p += A[h[i] % 31];
    return p;
}

String esc(const std::string &s)
{
    String o;
    for (char c : s) {
        if (c == '<')
            o += "&lt;";
        else if (c == '>')
            o += "&gt;";
        else if (c == '&')
            o += "&amp;";
        else if (c == '"')
            o += "&quot;";
        else
            o += c;
    }
    return o;
}

const char *STYLE = "<meta name=viewport content='width=device-width,initial-scale=1'><style>"
                    "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px;max-width:560px;color:#1c2321;background:#f6f7f5}"
                    "h1{font-size:1.4rem;margin:0 0 4px}p,ol{color:#3d4945}label{display:block;font-weight:600;margin:14px 0 4px}"
                    "input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #c9d1cd;border-radius:8px;background:#fff}"
                    "button{margin-top:20px;width:100%;padding:12px;font:inherit;font-weight:600;color:#fff;background:#1f7a5c;border:0;border-radius:8px}"
                    ".hint{font-weight:400;color:#5d6965;font-size:.9rem}.err{color:#a3341f}code{word-break:break-all;background:#e2f1eb;padding:2px 4px;border-radius:4px}</style>";

struct RegionChoice {
    int code;
    const char *name;
};
const RegionChoice REGIONS[] = {{1, "United States (US 915)"},
                                {3, "Europe (EU 868)"},
                                {2, "Europe (EU 433)"},
                                {6, "Australia / NZ (ANZ 915)"},
                                {11, "New Zealand (NZ 865)"},
                                {10, "India (IN 865)"},
                                {5, "Japan (JP 920)"},
                                {7, "Korea (KR 920)"},
                                {8, "Taiwan (TW 923)"},
                                {4, "China (CN 470)"},
                                {9, "Russia (RU 868)"},
                                {12, "Thailand (TH 920)"},
                                {18, "Singapore (SG 923)"},
                                {17, "Malaysia (MY 919)"},
                                {21, "Philippines (PH 915)"},
                                {26, "Brazil (BR 902)"},
                                {15, "Ukraine (UA 868)"},
                                {24, "Kazakhstan (KZ 863)"},
                                {25, "Nepal (NP 865)"}};

} // namespace

// Each character from the GPS module, handed over by the hook register.py
// adds to GPS.cpp: the satellites in view, which Meshtastic doesn't keep.
void hcGpsChar(char c)
{
    radio.skyView.feed(c, hcio::nowMs());
}

HomeBaseModule::HomeBaseModule()
    : SinglePortModule("homebase", meshtastic_PortNum_TEXT_MESSAGE_APP), concurrency::OSThread("HomeBase")
{
    ota::checkBoot(); // an update that keeps restarting goes back
    isPromiscuous = true; // trackers' texts and HomeCircle packets come as broadcasts
    homeBaseModule = this;
    setIntervalFromNow(5000);
}

// --- the private channel ---------------------------------------------------------

int HomeBaseModule::channelIndex()
{
    for (int i = 0; i < MAX_NUM_CHANNELS; i++) {
        meshtastic_Channel &c = channels.getByIndex(i);
        if (c.role != meshtastic_Channel_Role_DISABLED && strcmp(c.settings.name, CHANNEL) == 0)
            return i;
    }
    return -1;
}

// A secondary channel named HomeCircle with a random key. This node's own
// primary channel stays as it was, so it keeps its frequency and the public mesh.
int HomeBaseModule::ensureChannel()
{
    int idx = channelIndex();
    if (idx >= 0)
        return idx;
    for (int i = 1; i < MAX_NUM_CHANNELS; i++) {
        meshtastic_Channel ch = channels.getByIndex(i);
        if (ch.role != meshtastic_Channel_Role_DISABLED)
            continue;
        ch.index = i;
        ch.role = meshtastic_Channel_Role_SECONDARY;
        ch.has_settings = true;
        memset(&ch.settings, 0, sizeof ch.settings);
        strncpy(ch.settings.name, CHANNEL, sizeof ch.settings.name - 1);
        ch.settings.psk.size = 32;
        randombytes_buf(ch.settings.psk.bytes, 32);
        ch.settings.has_module_settings = true;
        ch.settings.module_settings.position_precision = 32; // full precision: it's private
        channels.setChannel(ch);
        channels.onConfigChanged();
        return i;
    }
    return -1;
}

// For a tracker: our channel as its primary (positions go out on the primary),
// with a LoRa setting that keeps it on this node's frequency slot. Without the
// slot, a primary channel named HomeCircle would hash to another frequency
// and other people's nodes couldn't relay for it.
std::string HomeBaseModule::channelLink()
{
    int idx = channelIndex();
    if (idx < 0 || !myRegion)
        return "";
    meshtastic_ChannelSet cs = meshtastic_ChannelSet_init_zero;
    cs.settings_count = 1;
    cs.settings[0] = channels.getByIndex(idx).settings;
    cs.has_lora_config = true;
    cs.lora_config = config.lora;
    float bw;
    uint8_t sf, cr;
    modemPresetToParams(config.lora.modem_preset, myRegion->wideLora, bw, sf, cr);
    uint32_t n = (uint32_t)floor((myRegion->freqEnd - myRegion->freqStart) / (myRegion->spacing + (bw / 1000)));
    if (n) {
        uint32_t slot = config.lora.channel_num ? config.lora.channel_num - 1 : hash(channels.getName(channels.getPrimaryIndex())) % n;
        cs.lora_config.channel_num = slot + 1;
    }
    uint8_t buf[320];
    size_t len = pb_encode_to_bytes(buf, sizeof buf, &meshtastic_ChannelSet_msg, &cs);
    return "https://meshtastic.org/e/#" + hc::toB64(buf, len);
}

// --- the radio -----------------------------------------------------------------------

std::map<uint32_t, uint32_t> positionAsks; // node -> our latest position request's id

// A packet names its last relay by the low byte of its node number only: the
// node we know with that byte that was heard most lately (0 if none).
uint32_t relayNode(uint8_t low, uint32_t from)
{
    if (!low)
        return 0;
    uint32_t best = 0, bestHeard = 0;
    for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
        if (!n || n->num == from || n->num == nodeDB->getNodeNum() || (n->num & 0xff) != low)
            continue;
        if (n->last_heard >= bestHeard)
            best = n->num, bestHeard = n->last_heard;
    }
    return best;
}

void HomeBaseModule::askPosition(uint32_t node)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_POSITION_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    p->decoded.want_response = true; // its position module answers with where it is
    p->decoded.payload.size = 0;
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    positionAsks[node] = p->id;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: asked %08x for a position", (unsigned)node);
}

// A direct text to a node. One starting with the bell character makes a
// tracker beep when its External Notification is set to sound for alert bells.
void HomeBaseModule::textNode(uint32_t node, const std::string &text)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    size_t len = std::min(text.size(), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text.data(), len);
    p->decoded.payload.size = len;
    p->want_ack = true;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: sent %08x a text (%u bytes)", (unsigned)node, (unsigned)len);
}

void HomeBaseModule::broadcastPrivate(const std::string &text)
{
    int idx = channelIndex();
    if (idx < 0)
        return;
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_PRIVATE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = idx;
    size_t len = std::min(text.size(), sizeof(p->decoded.payload.bytes));
    memcpy(p->decoded.payload.bytes, text.data(), len);
    p->decoded.payload.size = len;
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_ALERT;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: sent %s", text.c_str());
}

// A traceroute to a node: each relay adds itself on the way there and back
// (Meshtastic's TraceRouteModule); the answer comes to handleReceived.
void HomeBaseModule::traceNode(uint32_t node)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    p->decoded.portnum = meshtastic_PortNum_TRACEROUTE_APP;
    p->to = node;
    meshtastic_NodeInfoLite *n = nodeDB->getMeshNode(node);
    int idx = channelIndex();
    p->channel = n && n->channel ? n->channel : (idx >= 0 ? idx : channels.getPrimaryIndex());
    p->decoded.want_response = true;
    p->decoded.payload.size = 0; // an empty RouteDiscovery
    p->want_ack = false;
    p->priority = meshtastic_MeshPacket_Priority_RELIABLE;
    service->sendToMesh(p);
    LOG_INFO("HomeCircle home base: traceroute to %08x", (unsigned)node);
}

bool HomeBaseModule::wantPacket(const meshtastic_MeshPacket *p)
{
    if (!p || p->which_payload_variant != meshtastic_MeshPacket_decoded_tag)
        return false;
    meshtastic_PortNum port = p->decoded.portnum;
    return port == meshtastic_PortNum_TEXT_MESSAGE_APP || port == meshtastic_PortNum_PRIVATE_APP || port == meshtastic_PortNum_POSITION_APP ||
           port == meshtastic_PortNum_TRACEROUTE_APP || port == meshtastic_PortNum_ADMIN_APP || port == meshtastic_PortNum_ROUTING_APP ||
           port == meshtastic_PortNum_TELEMETRY_APP || port == meshtastic_PortNum_NODEINFO_APP; // any sign of a tracker
}

ProcessMessage HomeBaseModule::handleReceived(const meshtastic_MeshPacket &mp)
{
    if (!configured || mp.from == nodeDB->getNodeNum())
        return ProcessMessage::CONTINUE;
    const auto &pl = mp.decoded.payload;
    // Any packet from a tracker: how it got here (this node's radio, or a gateway over the
    // internet bridge); one long silent gets asked where it is.
    hc::Source src = mp.via_mqtt ? hc::Source::Internet : hc::Source::Radio;
    int hops = mp.hop_start ? (int)mp.hop_start - (int)mp.hop_limit : -1;
    if (mp.decoded.portnum != meshtastic_PortNum_POSITION_APP && hb.isTracker(mp.from))
        hb.onHeard(mp.from, hops, relayNode(mp.relay_node, mp.from), mp.rx_snr, false, src);
    switch (mp.decoded.portnum) {
    case meshtastic_PortNum_TEXT_MESSAGE_APP:
        hb.onText(mp.from, std::string((const char *)pl.bytes, pl.size));
        break;
    case meshtastic_PortNum_PRIVATE_APP:
        // A HomeCircle tracker's button ("#press N", sent as data so other trackers don't beep),
        // or a HomeCircle-firmware tracker's sealed packet.
        if ((pl.size > 7 && memcmp(pl.bytes, "#press ", 7) == 0) || (pl.size > 8 && memcmp(pl.bytes, "#cfg-ok ", 8) == 0))
            hb.onText(mp.from, std::string((const char *)pl.bytes, pl.size));
        else if (pl.size > 0 && pl.bytes[0] == '#')
            break; // our own "#sos-ack"/"#cfg" coming back through the mesh
        else
            hb.onMeshPacket(hc::Bytes(pl.bytes, pl.bytes + pl.size));
        break;
    case meshtastic_PortNum_POSITION_APP:
        if (hb.isTracker(mp.from))
            hb.onHeard(mp.from, hops, relayNode(mp.relay_node, mp.from), mp.rx_snr, true, src);
        lastPoll = 0; // the node database has it now: pass it on soon
        break;
    case meshtastic_PortNum_ADMIN_APP:
        if (mp.to == nodeDB->getNodeNum())
            configAnswer(mp);
        break;
    case meshtastic_PortNum_ROUTING_APP:
        if (mp.to != nodeDB->getNodeNum())
            break;
        // A tracker with no GPS fix answers a position request with a routing message, not a position.
        if (mp.decoded.request_id && positionAsks.count(mp.from) && positionAsks[mp.from] == mp.decoded.request_id && hb.isTracker(mp.from)) {
            positionAsks.erase(mp.from);
            LOG_INFO("HomeCircle home base: %08x has no GPS fix", (unsigned)mp.from);
            hb.onNoFix(mp.from);
            break;
        }
        configRouting(mp);
        break;
    case meshtastic_PortNum_TRACEROUTE_APP: {
        // The answer to our traceroute: route_back lists the relays the answer
        // passed through, in order, from the tracker towards us.
        if (!mp.decoded.request_id || mp.to != nodeDB->getNodeNum() || !hb.isTracker(mp.from))
            break;
        meshtastic_RouteDiscovery r = meshtastic_RouteDiscovery_init_zero;
        if (!pb_decode_from_bytes(pl.bytes, pl.size, &meshtastic_RouteDiscovery_msg, &r))
            break;
        std::vector<uint32_t> back(r.route_back, r.route_back + r.route_back_count);
        std::vector<int> snr(r.snr_back, r.snr_back + r.snr_back_count);
        if (snr.size() <= back.size())
            snr.resize(back.size() + 1, -128), snr[back.size()] = (int)(mp.rx_snr * 4); // how we heard the last hop
        hb.onRoute(mp.from, back, snr);
        LOG_INFO("HomeCircle home base: path from %08x has %u relay(s)", (unsigned)mp.from, (unsigned)back.size());
        break;
    }
    default:
        break;
    }
    return ProcessMessage::CONTINUE;
}

// Trackers' latest positions and battery, from what this node has heard.
void HomeBaseModule::pollPositions()
{
    for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
        meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
        if (!n || !n->has_position || !hb.isTracker(n->num))
            continue;
        const meshtastic_PositionLite &p = n->position;
        if ((!p.latitude_i && !p.longitude_i) || !p.time || seenFix[n->num] >= p.time)
            continue;
        seenFix[n->num] = p.time;
        hc::Fix fix;
        fix.lat = p.latitude_i * 1e-7;
        fix.lng = p.longitude_i * 1e-7;
        if (n->has_device_metrics && n->device_metrics.has_battery_level) {
            uint32_t b = n->device_metrics.battery_level;
            fix.battery = b > 100 ? 100 : (int)b; // 101: on external power
            fix.charging = b > 100;
        }
        hb.onPosition(n->num, fix, (int64_t)p.time * 1000);
    }
}

// --- setup ------------------------------------------------------------------------------

void HomeBaseModule::startPortal()
{
    apSsid = "HomeCircle Home Base " + deviceSuffix();
    apPass = apPassword();
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(apSsid.c_str(), apPass.c_str());
    dns = new DNSServer();
    dns->start(53, "*", WiFi.softAPIP());
    web = new WebServer(80);
    portalStarted = millis();
    region = config.lora.region;
    needInvite = !hb.ready();

    web->on("/", HTTP_GET, []() {
        String page = String("<!doctype html><title>HomeCircle home base</title>") + STYLE;
        if (needInvite)
            page += "<h1>Set up this home base</h1><p>It joins your HomeCircle circle over your home Wi-Fi and passes on what "
                    "Meshtastic trackers send. An admin makes an invite in the HomeCircle app (Settings → your circle → Invite someone).</p>";
        else
            page += "<h1>Wi-Fi for this home base</h1><p>It's already in <b>" + esc(hb.base().circleName()) +
                    "</b>, but it has no home Wi-Fi to reach your server.</p>";
        // Wi-Fi it already has: filled in, and the saved password is kept if the box is left empty.
        String saved = config.network.wifi_ssid;
        page += "<form method=post action=/setup>"
                "<label for=s>Home Wi-Fi network <span class=hint>(2.4 GHz)</span></label><input id=s name=s required value=\"" +
                esc(saved.c_str()) + "\">";
        if (saved.length())
            page += "<label for=p>Wi-Fi password <span class=hint>(leave empty to keep the one it has)</span></label><input id=p name=p type=password>";
        else
            page += "<label for=p>Wi-Fi password</label><input id=p name=p type=password>";
        if (needInvite)
            page += "<label for=i>Invite link <span class=hint>(it names your HomeCircle server too)</span></label>"
                    "<textarea id=i name=i rows=3 required></textarea>";
        page += "<label for=r>Where you are <span class=hint>(LoRa radios must use their country's band)</span></label><select id=r name=r>";
        for (auto &r : REGIONS)
            page += String("<option value=") + r.code + (r.code == region ? " selected" : "") + ">" + r.name + "</option>";
        page += "</select><button>Set up</button></form>";
        web->send(200, "text/html; charset=utf-8", page);
    });
    web->on("/setup", HTTP_POST, []() {
        wifiSsid = web->arg("s").c_str();
        wifiPass = web->arg("p").c_str();
        // The same network it already has, password left empty: keep the saved one.
        if (wifiPass.empty() && wifiSsid == config.network.wifi_ssid)
            wifiPass = config.network.wifi_psk;
        invite = web->arg("i").c_str();
        region = web->arg("r").toInt();
        job = Job::Joining;
        web->sendHeader("Location", "/status");
        web->send(303);
    });
    web->on("/status", HTTP_GET, []() {
        String body;
        if (job == Job::Joining) {
            body = needInvite ? "<meta http-equiv=refresh content=3><h1>Setting up…</h1><p>Joining your Wi-Fi and your circle. This can take a minute.</p>"
                              : "<meta http-equiv=refresh content=3><h1>Setting up…</h1><p>Joining your Wi-Fi.</p>";
        } else if (job == Job::Joined) {
            std::string link = homeBaseModule->channelLink();
            body = "<h1>Done</h1><p>This home base is in <b>" + esc(hb.base().circleName()) +
                   "</b>. It restarts in a minute and then runs on your Wi-Fi.</p><ol>"
                   "<li>In HomeCircle, make <b>Home base</b> an admin, so it can add trackers.</li>"
                   "<li>Put each tracker on the private channel: on a phone connected to the tracker in the Meshtastic app, open<br><code>" +
                   esc(link) +
                   "</code><br>(You can get this link again by sending <b>channel</b> to Home base in the HomeCircle chat.)</li>"
                   "<li>In the HomeCircle chat, send <b>list</b> to Home base, then <b>add !id Name</b> for each tracker.</li></ol>";
        } else if (job == Job::Failed) {
            body = "<h1 class=err>That didn’t work</h1><p>" + esc(jobError) + "</p><p><a href=/>Try again</a></p>";
        } else {
            body = "<meta http-equiv=refresh content=0;url=/>";
        }
        web->send(200, "text/html; charset=utf-8", String("<!doctype html><title>HomeCircle home base</title>") + STYLE + body);
    });
    web->onNotFound([]() {
        web->sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/");
        web->send(302);
    });
    web->begin();
    LOG_INFO("HomeCircle home base: setup on Wi-Fi \"%s\", password %s, http://%s", apSsid.c_str(), apPass.c_str(),
             WiFi.softAPIP().toString().c_str());
#if HAS_SCREEN
    if (screen) {
        static char banner[96];
        snprintf(banner, sizeof banner, "Setup: join Wi-Fi\n%s\nPassword %s", apSsid.c_str(), apPass.c_str());
        screen->showSimpleBanner(banner, PORTAL_MS);
    }
#endif
}

void HomeBaseModule::portalLoop()
{
    dns->processNextRequest();
    web->handleClient();
    if (job == Job::Joining) {
        // Already on that network (it only needed an invite): don't drop the connection to join it again.
        bool already = WiFi.status() == WL_CONNECTED && WiFi.SSID() == wifiSsid.c_str() && wifiPass == config.network.wifi_psk;
        if (!already)
            WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
        uint32_t t = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - t < 30000) {
            web->handleClient();
            hcio::feedWatchdog();
            delay(50);
        }
        if (WiFi.status() != WL_CONNECTED) {
            job = Job::Failed;
            jobError = "It couldn't join that Wi-Fi network. Check the name and password (2.4 GHz networks only).";
            return;
        }
        // Meshtastic's own settings first, so they're kept whatever happens
        // next: the region, home Wi-Fi from now on, and the private channel.
        if (region > 0)
            config.lora.region = (meshtastic_Config_LoRaConfig_RegionCode)region;
        config.network.wifi_enabled = true;
        memset(config.network.wifi_ssid, 0, sizeof config.network.wifi_ssid);
        memset(config.network.wifi_psk, 0, sizeof config.network.wifi_psk);
        strncpy(config.network.wifi_ssid, wifiSsid.c_str(), sizeof config.network.wifi_ssid - 1);
        strncpy(config.network.wifi_psk, wifiPass.c_str(), sizeof config.network.wifi_psk - 1);
        ensureChannel();
        bool saved = nodeDB->saveToDisk(SEGMENT_CONFIG | SEGMENT_CHANNELS);
        LOG_INFO("HomeCircle home base: settings %s", saved ? "saved" : "NOT saved");
        hcio::feedWatchdog();
        if (needInvite) {
            hc::Status s = hb.setup(invite);
            invite.clear();
            hcio::feedWatchdog();
            if (s != hc::Status::Ok) {
                job = Job::Failed;
                jobError = "It joined your Wi-Fi but couldn't join the circle: " + hb.base().error();
                return;
            }
        }
        job = Job::Joined;
        joinedAt = millis();
        LOG_INFO("HomeCircle home base: set up in %s", hb.base().circleName().c_str());
    }
    if (job == Job::Joined && millis() - joinedAt > 60000 && !rebootAtMsec)
        rebootAtMsec = millis() + 1000; // start again on the home Wi-Fi
    if (job != Job::Joined && millis() - portalStarted > PORTAL_MS && !rebootAtMsec)
        rebootAtMsec = millis() + 1000; // nobody came: start again, and the page opens again
}

int32_t HomeBaseModule::runOnce()
{
    if (!started) {
        started = true;
        hc::cryptoInit();
        bool joined = hb.load();
        bool wifi = config.network.wifi_enabled && config.network.wifi_ssid[0];
        // Repair what an interrupted setup may have left out.
        if (joined && channelIndex() < 0) {
            ensureChannel();
            nodeDB->saveToDisk(SEGMENT_CHANNELS);
            LOG_INFO("HomeCircle home base: made the private HomeCircle channel");
        }
        configured = joined && wifi;
        if (!configured) {
            // Not in a circle yet, or in one with no home Wi-Fi: the setup page asks for what's missing.
            startPortal();
        } else {
            LOG_INFO("HomeCircle home base: in %s with %u tracker(s)", hb.base().circleName().c_str(), (unsigned)hb.trackerCount());
        }
    }
    if (!configured) {
        portalLoop();
        return 5;
    }
    if (millis() - lastPoll > 5000 || !lastPoll) {
        pollPositions();
        lastPoll = millis();
    }
    configTimeouts();
    if (hcio::online() && millis() - lastTick > 5000) {
        hb.tick();
        if (!hb.log.empty()) {
            LOG_INFO("HomeCircle home base: %s (stack never below %u bytes free)", hb.log.c_str(),
                     (unsigned)uxTaskGetStackHighWaterMark(NULL));
        }
        hb.log.clear();
        lastTick = millis();
        // Back from an update (or from going back): its status reached the server, so say how it went.
        if (!updateConfirmed && hb.reportedAt()) {
            updateConfirmed = true;
            ota::confirm();
        }
        hc::HomeBase::Update u;
        if (hb.takeUpdate(u)) {
            LOG_INFO("HomeCircle home base: updating from %s", u.url.c_str());
            std::string err = ota::install(u);
            if (err.empty()) {
                LOG_INFO("HomeCircle home base: update written; restarting into it");
                rebootAtMsec = millis() + 2000;
            } else {
                LOG_WARN("HomeCircle home base: update failed: %s", err.c_str());
                hb.updateNews(u.by, "⚠️ The update didn't work: " + err + ". I'm still on " + HC_FW_VERSION + ".");
            }
        }
    }
    return 1000;
}

#endif
