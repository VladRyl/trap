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
2. General tickets have **Close** and **Block user** buttons. They cannot issue refunds.
3. Payment tickets have **Choose refund**, **Close**, and **Block user** buttons. The refund flow lists up to 10 exact unrefunded purchases with the Stars amount, lives, Kyiv date/time and a short reference. Selecting one requires a second **Confirm** click.
4. As a fallback, reply `/refund` to a relayed message in a payment ticket, reply `/refund TELEGRAM_CHARGE_ID` to select a particular purchase, or reply `/close` to close either ticket type.
5. Standalone `/refund` and `/close` commands are intentionally rejected because they are not associated with a ticket ID.

Blocking requires a second confirmation click. It closes every open ticket for that Telegram user and immediately denies bot callbacks, inline mode, checkout, new Mini App sessions, and API access from existing sessions. The configured administrator cannot be blocked. To restore access manually in Cloudflare D1, delete the matching row:

```sql
DELETE FROM blocked_users WHERE user_id = 123456789;
```

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

## Growth analytics and referrals

The private `/stats` command is restricted to `ADMIN_USER_ID`; it should not be added to the public BotFather command menu. It reports the tracked Mini App funnel, payments, refunds, referral qualification and the leading referrers. Gameplay analytics begin with the release that creates `analytics_events`; earlier gameplay is not reconstructed.

Challenge shares use Telegram prepared photo messages and links shaped like `https://t.me/trap_game_bot/play?startapp=r_CODE`. The message includes the TRAP image, the sender's personal bot link, and an explicit notice that only brand-new players qualify. On the first share for an asset version, the Worker briefly sends the image to `ADMIN_USER_ID`, stores the returned Telegram `file_id` in `bot_assets`, deletes the setup message, and uses the Telegram-cached photo thereafter; the public JPEG remains a fallback. Attribution is accepted only for a player who did not already exist when the signed Mini App session was created. After that new player clears Level 1, both the referrer and the new player receive five non-transferable `rewardLives`. Self-referrals and duplicate rewards are rejected by database constraints. There is intentionally no lifetime or weekly reward cap during launch.

Life consumption order is regular lives, bonus lives, then purchased lives. Referral and rewarded-ad bonuses share the non-purchased `rewardLives` reserve, so payment refunds never remove them.

## AdsGram rewarded ads

The Game Over screen can grant two bonus lives after a completed AdsGram rewarded ad. Configuration uses:

- `ADSGRAM_BLOCK_ID`: numeric AdsGram Reward block ID.
- `ADSGRAM_DEBUG`: `1` for a test platform; only `ADMIN_USER_ID` sees and can claim the test reward. Set it to `0` for production.
- `ADSGRAM_REWARD_SECRET`: production-only Cloudflare secret used to authenticate the AdsGram server callback.

Debug ads do not call Reward URL. The verified admin client therefore uses `/api/adsgram/test-reward`; the Worker rejects every other user. In production, the browser never grants lives directly. AdsGram must call the authenticated Worker endpoint, which grants at most one reward for a particular Game Over state and applies a 30-second cooldown.

For production, generate a long random secret, store it as the Cloudflare Worker secret `ADSGRAM_REWARD_SECRET`, and configure this exact Reward URL in AdsGram (replace `SECRET` without brackets):

```text
https://trap-game.trap-games.workers.dev/api/adsgram/reward?userid=[userId]&secret=SECRET
```

After changing to the production Block ID, set `ADSGRAM_DEBUG` to `0`, deploy, complete a real ad, and confirm that `ad_rewards.granted_at` is populated and `/stats` reports the rewarded ad. Do not expose the production secret in `wrangler.jsonc`, GitHub, the Mini App HTML or client JavaScript.

## Encrypted D1 backups

Cloudflare D1 Time Travel remains the quickest recovery path. The GitHub workflow `.github/workflows/d1-backup.yml` additionally exports the full production D1 database every day, encrypts it before upload, and retains the encrypted artifact for 30 days. This includes players, analytics, attribution, referrals, invoices, payments, refunds, terms acceptances and support tickets.

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
