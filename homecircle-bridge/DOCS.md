# HomeCircle Bridge

Connects Home Assistant to your family's HomeCircle circle, wherever the
HomeCircle server runs (Render, a VPS, or the HomeCircle app on this Home
Assistant).

The bridge joins the circle as a member called **Home Assistant**, with its
own keys kept here. Messages and locations stay end-to-end encrypted: the
HomeCircle server still can't read them. In the app it shows as a device, not
as a person.

- **Trackers in Home Assistant.** Each Meshtastic tracker in the circle
  becomes a device here (like a phone with the Companion app): a
  `device_tracker` that Home Assistant puts in your zones, and a battery
  sensor. People come in through HomeCircle's own **Home Assistant** plugin,
  each from their own phone, so each person can turn it off.
- **Post to the family chat** from an automation or a script.
- **The chat in automations:** every new message fires an event.

## Set up (5 minutes)

1. In the HomeCircle app: **Invite someone** and copy the invite link.
2. Here, open the **Configuration** tab, paste the link into **invite_link**,
   and click **Save**.
3. Open the **Info** tab, turn on **Start on boot** and **Watchdog**, and click
   **Start**.
4. The **Log** tab says `joined the circle as Home Assistant`. The link is
   used once; you can clear it afterwards.

## Post to the chat

Fire the event `homecircle_send` with a `message`. Add `to` (someone's name
in the circle) for a direct message instead of the group chat.

```yaml
# An automation's action
- event: homecircle_send
  event_data:
    message: "The garage door has been open for 10 minutes"
```

```yaml
# A direct message to one person
- event: homecircle_send
  event_data:
    message: "Your package arrived"
    to: Maya
```

## When a message comes in

Each new message fires `homecircle_message` with `from` (their name), `text`,
`direct` (true for a direct message to Home Assistant) and `at`.

```yaml
triggers:
  - trigger: event
    event_type: homecircle_message
    event_data:
      from: Leo
conditions:
  - condition: template
    value_template: "{{ 'home' in trigger.event.data.text | lower }}"
actions:
  - action: light.turn_on
    target:
      entity_id: light.porch
```

## Options

- **invite_link**: an invite from the app, for the first start only.
- **name**: how the bridge is named in the circle (default "Home Assistant").
- **trackers**: send the circle's trackers to Home Assistant (on by default).
- **chat**: post `homecircle_send` events and fire `homecircle_message` (on by
  default).

To leave the circle, remove **Home Assistant** in the app (Settings → People),
then uninstall the bridge.
