# TRAP operations

## Support proxy

The Worker needs two Cloudflare variables:

- `ADMIN_USER_ID`: the only Telegram user allowed to answer tickets and issue refunds.
- `SUPPORT_CHAT_ID`: the private chat or private group where support tickets arrive.

Send `/myid` to the bot to get both your user ID and current chat ID. For a private admin chat, set both variables to your user ID. For a private support group, add the bot, send `/chatid` in the group, use that negative value as `SUPPORT_CHAT_ID`, and keep your personal ID as `ADMIN_USER_ID`.

Player flow:

1. `/support` opens a general ticket; `/paysupport` opens a payment ticket.
2. The PLAY message exposes the same actions as inline **Terms**, **Support**, and **Payments & refunds** buttons.
3. The next text, photo or document is copied into the support chat.
4. The player uses the ticket-bound **Finish support** button or `/done` to close the ticket. A stale button cannot close a newer ticket.

Admin flow:

1. Reply to a relayed message; the bot copies the reply to the player without exposing the admin account.
2. General tickets have a **Close** button. They cannot issue refunds.
3. Payment tickets have **Choose refund** and **Close** buttons. The refund flow lists up to 10 exact unrefunded purchases with the Stars amount, lives, Kyiv date/time and a short reference. Selecting one requires a second **Confirm** click.
4. As a fallback, reply `/refund` to a relayed message in a payment ticket, reply `/refund TELEGRAM_CHARGE_ID` to select a particular purchase, or reply `/close` to close either ticket type.
5. Standalone `/refund` and `/close` commands are intentionally rejected because they are not associated with a ticket ID.

Refunds are intentionally unconditional and admin-controlled. If the player already consumed the purchased lives, the Stars are still returned and no consumed lives can be recovered. Every attempt is recorded in `refunds`; completed purchases remain in `payments` as an immutable audit trail.

## Telegram commands

Recommended BotFather/Bot API commands:

```text
play - Play TRAP
scores - Open the leaderboard
terms - Terms and refund policy
support - Contact support
paysupport - Payment and refund support
myid - Show your Telegram ID
done - Close your support ticket
```

## Encrypted D1 backups

Cloudflare D1 Time Travel remains the quickest recovery path. The GitHub workflow `.github/workflows/d1-backup.yml` additionally exports the full production D1 database every day, encrypts it before upload, and retains the encrypted artifact for 30 days. This includes players, invoices, payments, refunds, terms acceptances and support tickets.

Create these GitHub Actions repository secrets:

- `CLOUDFLARE_API_TOKEN`: a token with D1 read access to `trap-game-db`.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `BACKUP_PASSWORD`: a long, unique password stored outside GitHub as well.

Run the workflow manually once from **GitHub → Actions → Encrypted D1 backup → Run workflow** and verify that an `.enc` artifact appears.

To decrypt a downloaded backup locally:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -in BACKUP.sql.gz.enc -out BACKUP.sql.gz
gzip -d BACKUP.sql.gz
```

Import into a new/test D1 database first; do not test restoration against production. A SQL export can then be applied with Wrangler's `d1 execute --file` command after reviewing the target database.
