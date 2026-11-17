# Scheduled reminders and morning updates

Bell can check Notion and reply through Linq without waiting for a message. The fixed
morning job uses Eve's `defineSchedule`. User-requested reminders and recurring tasks use
`defineDynamicSchedules` from `eve/experimental/schedules`.

## Configure schedules

Complete [Linq setup](linq.md) with Bell's receiving line and your personal sender allowlist.
For morning updates, connect [Notion](notion.md) in that private Linq chat. No additional
Bell environment variables, credentials, or database migration are needed.

The morning job finds existing private chats through Linq's API and uses each participant's
Linq identity to check their existing Notion connection. It skips groups, archived chats,
other receiving lines, senders outside the allowlist, and disconnected Notion accounts.
It does not create chats or send an update to a new recipient.

Bell uses the machine's local timezone without asking the user. Linq does not expose the
phone's device timezone, so a deployed host must use the intended local timezone. An
explicit choice or saved Notion timezone preference takes precedence for user-created tasks.

Bell pins Eve 0.79.1. Fixed cron expressions use UTC on Vercel, so the morning handler checks
every 15 minutes and starts Bell only in the local 8:30 AM slot, before 8:45. This follows
daylight saving changes. Vercel Cron needs a plan that supports this frequency; Hobby
supports daily jobs only. Built Eve servers can also run the fixed job with their schedule
runner active. Plain `pnpm dev` does not fire fixed schedules automatically.

Dynamic schedules use Vercel Schedules and Queues and require the experimental organization
feature flag in this Eve version. For local dynamic delivery, use `vercel dev` with
[local Schedules support](https://vercel.com/docs/schedules/local-development).

## Use from your phone

Once Notion is connected in your private chat, Bell's morning run checks current plans,
unfinished priorities, and approaching deadlines at 8:30 AM. Bell replies in the existing
chat with useful source links. It uses `no_reply` when a successful check finds nothing
to share.

Text Bell for additional reminders:

- "Remind me to buy milk in ten minutes."
- "Every evening at 7 PM, check Notion for tomorrow's travel plans."
- "Move my travel briefing to 6 PM."
- "Cancel my travel briefing."

Eve provides the management tools, approvals, and creator isolation. Bell captures the
verified destination when the user creates a reminder and rechecks the sender allowlist
when it runs. The existing Bell agent handles the task and delivers its reply through Linq.
Explicit reminders do not require Notion.

## Persistence and recovery

Morning runs read existing chats from Linq and reuse the sender's Notion grant. They do not
depend on the conversation staying open. Web and Linq Notion grants remain separate.
Scheduled Notion access is read-only; Bell cannot change notes or mark tasks complete.

Dynamic records persist through Vercel Schedules. Under plain `pnpm dev`, they are
process-local and disappear on restart. Editing a Notion note does not change or cancel
a reminder. Dynamic management tools control user-created reminders; the fixed morning
job is controlled in code and hosting configuration.

Eve 0.79.1 can repeat a dynamic notification after a delivery retry. Cancellation stops
future occurrences and cannot recall a running task or sent message.

## Verify

`pnpm check` covers chat discovery, sender access, local timing, native reminder management,
and Notion read-only access. Provider HTTP and model execution are mocked; tests send no texts.

For a live check, connect Notion in your private Linq chat and verify the morning update
arrives there. Ask for a reminder in a few minutes, then change or cancel a recurring one.
This needs the existing provider credentials and an active scheduler. Automated tests do
not establish live phone delivery.

See Eve's [fixed schedules](https://eve.dev/docs/schedules) and
[dynamic schedules](https://eve.dev/docs/experimental/dynamic-schedules) guides. Their latest
examples may use options introduced after Bell's pinned version.
