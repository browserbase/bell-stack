# Scheduled reminders and morning updates

Bell sends a daily Notion briefing and user-requested reminders to your private Linq chat.

## Configure schedules

Complete [Linq setup](linq.md) with Bell's receiving line and your sender allowlist.
For morning briefings, [connect Notion](notion.md) in that chat. Bell sends briefings
only to existing private chats with an allowed sender and a connected Notion account.

The morning briefing runs at 8:30 AM in Bell's local timezone. Set `TZ` in the build
and runtime environments if the host's timezone differs from yours. For reminders
you request, specify a timezone in your message if you want to override the default.

On Vercel, the morning job uses Vercel Schedules. On a self-hosted Node server, it
runs while `eve start` is active. In development, trigger it on demand with
`POST /eve/v1/dev/schedules/morning`.

User-requested reminders need Vercel Schedules and Queues for automatic delivery.
Use `vercel dev` with [local Schedules support](https://vercel.com/docs/schedules/local-development)
to test delivery locally.

## Use from your phone

Once Notion is connected, Bell checks unfinished priorities, current plans, and
upcoming deadlines. It stays quiet after a successful check with nothing to report.

Text Bell to create or manage reminders:

- "Remind me to buy milk in ten minutes."
- "Every evening at 7 PM, check Notion for tomorrow's travel plans."
- "Move my travel briefing to 6 PM."
- "Cancel my travel briefing."

You can set a reminder without connecting Notion. Bell rechecks the sender allowlist
before running a reminder. Scheduled runs use read-only Notion access. Link checkout
requires an interactive Linq conversation.

## Persistence and recovery

Vercel Schedules stores user-requested reminders. Under plain `pnpm dev`, reminder
records are held in memory and disappear on restart. Editing a Notion note does
not change or cancel a reminder. Cancelling a reminder stops future runs. A run already
in progress can still send a message.

## Verify

`pnpm check` covers chat selection, the sender allowlist, reminder management, and
read-only Notion access. Tests use mocked provider calls and send no texts.

For a live check, connect Notion in your private Linq chat and trigger the morning
briefing. Ask for a reminder in two minutes and verify it arrives in the same chat.
Then change or cancel a recurring reminder.
