# pi-at

`pi-at` is a [Pi](https://pi.dev) extension that sends a prompt later: after a delay, or at a time of day.

```text
/at 4h check whether the nightly build passed
/at 4:35pm continue where you left off
```

The prompt is submitted as if you had typed it, once it is due and Pi is idle.

## Installation

Requires Node.js 22.19.0 or newer and Pi 1.3.0 or a later 1.x release. It is tested against Pi 1.3.0 and runs on the `jwiegley/pi` fork as well.

Install from a reviewed checkout:

```sh
pi install /absolute/path/to/pi-at
pi list
```

Run `/reload` or restart Pi afterward. To try it for one session instead, run `pi -e /absolute/path/to/pi-at`. Avoid loading both a Nix-managed copy and a local copy.

## Usage

| Command | Effect |
|---|---|
| `/at <time> <prompt>` | Send `<prompt>` at `<time>` |
| `/at` or `/at list` | List scheduled prompts with their ids and due times |
| `/at cancel <id>...` | Cancel prompts by id, written `3` or `#3` |
| `/at cancel all` | Cancel every scheduled prompt |

`/at` confirms each request with its id and resolved time, for example `Scheduled #1 for 4:35pm (in 3h 35m): continue where you left off`. While prompts are pending, the footer shows the next one: `◷ at 4:35pm +2`. Completion after `/at ` offers `list`, plus `cancel` while prompts are pending; after `/at cancel ` it offers the pending ids.

### Times

A **delay** is one or more `<number><unit>` parts:

| Unit | Spellings |
|---|---|
| seconds | `s`, `sec`, `secs`, `second`, `seconds` |
| minutes | `m`, `min`, `mins`, `minute`, `minutes` |
| hours | `h`, `hr`, `hrs`, `hour`, `hours` |
| days | `d`, `day`, `days` |

Parts may be combined and fractional: `90s`, `1h30m`, `1h 30m`, `1.5h`, `90 minutes`, `1 hour 30 minutes`, `2d`.

A **clock time** names the next occurrence of that time in Pi's local time zone; a time that has already passed today means tomorrow. Accepted forms are `4:35pm`, `4:35 pm`, `4:35 p.m.`, `4pm`, `11:59:30pm`, `16:35`, `04:35`, `0:30`, `noon`, and `midnight`. Across a daylight-saving change the wall-clock time is kept; a time that the change skips resolves to the next valid instant.

Two forms are rejected rather than guessed:

- `1:00` through `11:59` without `am` or `pm` reads differently on 12- and 24-hour clocks. Write `4:35pm`, `4:35am`, or a 24-hour time with a leading zero such as `04:35`.
- A bare number such as `5` needs a unit or `am`/`pm`.

### Prompts

Everything after the time is the prompt, verbatim apart from surrounding whitespace, so multi-line prompts work. Prompt templates, skills (`/skill:name`), and extension commands, including `/at` itself, run as if typed when the prompt is sent.

Pi's built-in commands (`/compact`, `/new`, `/model`, and the rest) and `!` shell commands are refused when you schedule them. Pi runs those only from its editor; an extension can submit them only as plain text to the model.

## Delivery

- A due prompt waits until Pi is idle: it never interrupts or steers a running agent, and it waits out compaction. It is sent as soon as the current run settles.
- Prompts are sent one at a time. Prompts due together run one after another, each in its own run.
- Each prompt is announced with `Sending scheduled prompt #N` and then appears in the transcript as an ordinary user message; a scheduled command shows its own output.
- Timing follows the wall clock. The extension re-checks at least every 30 seconds, so a prompt that falls due while the machine sleeps is sent within 30 seconds of waking.

## Persistence

Every change to the pending prompts appends a snapshot to the session as a `pi-at/jobs` custom entry, which is never sent to the model. Prompts belong to the session rather than to a branch, so `/tree` navigation does not affect them.

- **`/reload`** restores pending prompts. A prompt that fell due during the reload is sent once Pi is idle.
- **Quit, then resume** (`pi -c`, `/resume`) restores prompts that are still in the future. A prompt that fell due while the session was closed is not sent, since sending it unannounced could surprise. Instead, a warning lists it and its text is placed in the editor, ahead of any draft, to send or discard.
- **`/new`, `/resume` into another session, or `/fork`** pauses the current session's prompts until you return to it; they do not follow you. A fork or clone that copies the snapshot carries its prompts into the new session.
- **Print and JSON modes** exit before anything could fall due. There, `/at` reports an error and the extension leaves scheduled prompts untouched.

## Limitations

- Prompts are sent only while Pi is running with their session open; there is no background daemon.
- Pi writes a session file only once it holds a message, so prompts scheduled in a new, empty session survive `/reload` but not quitting Pi.
- If Pi accepts a prompt but then fails to run it, for example because credentials expired, Pi reports the error and the prompt is not retried.
- Scheduled prompts are text only; images cannot be attached.

## Compatibility

`pi-at` ships erasable TypeScript with no build step and no runtime dependencies; Pi supplies the `@earendil-works/pi-coding-agent` host peer. It restores prompts through the fork's indexed `getLatestCustomEntry` lookup when the host provides one, and otherwise scans the session history.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check
```

Development dependencies are exact-pinned. Tests drive the extension through a fake host and a fake clock that can simulate a sleeping machine, plus real Pi sessions on the faux provider; they make no network or paid model calls. The package test packs the release files, installs the tarball offline, and loads it through Pi's resource loader.

## Removal

```sh
pi remove /absolute/path/to/pi-at
```

Run `/reload` or restart Pi afterward. Without the extension, existing `pi-at/jobs` session entries are inert.
