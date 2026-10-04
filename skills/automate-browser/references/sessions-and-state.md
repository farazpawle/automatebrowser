# Sessions, logins and browser state

## Contents

| Section | What it answers |
|---|---|
| [Start from "already signed in"](#start-from-already-signed-in) | Why you usually do not log in at all |
| [Credentials](#never-type-credentials-you-were-not-given) | The hard line |
| [2FA and CAPTCHA](#2fa-captcha-and-consent-screens) | How to stop cleanly |
| [Cookies and storage](#cookies-and-storage) | Reading and setting session state, and what is redacted |
| [Dialogs](#dialogs) | `alert`, `confirm`, `prompt`, "Leave site?" |
| [Uploads and downloads](#uploads-and-downloads) | Files in and out |
| [Restricted pages](#restricted-pages) | What refuses automation outright |
| [Signed-in vs signed-out bugs](#when-something-works-signed-in-and-fails-signed-out) | Diagnosing the difference |
| [Recipe: a session that will not stick](#recipe-it-says-i-am-signed-out--the-cookie-is-not-sticking) | Six calls, cheapest first |

---

## Start from "already signed in"

This drives the user's **real** browser. If they are signed in, **you are signed in** — navigating to
the page is usually the whole job. Do not go hunting for a login form first; check whether the page
you want simply loads.

```
browser_navigate { url: "https://app.example.com/settings" }
browser_read_page
```

Landing on a login screen is the *signal* that a session is missing. It is not an invitation to type
credentials you were never given.

## Never type credentials you were not given

If a flow needs a password and none was supplied: stop and say so. Do not read one out of a password
manager, a `.env` file, the page, or the repository. Ask, or hand the step back.

## 2FA, CAPTCHA and consent screens

A one-time code cannot be produced by you, and a CAPTCHA is a deliberate wall. The right move is a
clean pause:

1. Say exactly what the page is asking for.
2. Say that the tab is ready and waiting.
3. Stop, and let the user finish that step themselves.
4. Resume with `browser_snapshot` when they say they are through.

If the tab is one you opened in the background, use `browser_switch_tab` to bring it to them — this is
precisely the "show me" case that tool exists for.

Do not retry a CAPTCHA, and never click "resend code" repeatedly. That locks accounts.

## Cookies and storage

| Tool | Use |
|---|---|
| `browser_get_cookies` | Confirm a session cookie exists for this origin |
| `browser_set_cookie` | Restore a session you were explicitly given |
| `browser_storage` | `localStorage` / `sessionStorage` — where single-page apps keep tokens |

Values are **redacted by default** in what comes back, because they are the keys to the account.
`revealValues: true` exists; treat anything you do see as a secret and never write it to a file, a
commit, or a message.

**The same applies to request and response headers.** `browser_get_network_request` returns both
header sets with the body, and hides the value of `authorization`, `proxy-authorization`, `cookie`
and `set-cookie`, plus any name containing `token`, `api-key`, `apikey`, `secret`, `password` or
`credential` — case-insensitively, and the same `revealValues: true` opts out. Names are always
kept and the result counts what it withheld, so `<redacted>` means "an auth header you cannot see",
never "no auth header". That distinction is usually the whole answer when a request returns `401`.
You rarely need the real value: whether the header was **sent** is the bug, not what was in it.

Cookies are scoped to the URL of the tab you are driving, so navigate to the origin first.

A cookie session is shared across tabs of the same browser profile, so a tab you open is already
signed in. What is **not** shared is `sessionStorage` — a token kept there dies with its tab.

## Dialogs

`browser_handle_dialog { action: "accept" | "dismiss", promptText }` answers `alert`, `confirm` and
`prompt`. It also answers the native "Leave site?" prompt, which page JavaScript cannot even see.

This matters more than it sounds: **an unanswered dialog freezes the page**, so anything injected into
it never runs and your call waits out its entire timeout. A call that hangs and then times out is a
dialog until proven otherwise.

For a navigation you already know will trigger one, arm it in advance — this needs advanced mode:

```
browser_navigate { url: "...", handleBeforeUnload: "accept" }
```

## Uploads and downloads

- **`browser_upload_file { ref, filePaths }`** needs advanced mode — call
  `browser_advanced_mode { enable: true }` first, or you get `ADVANCED_MODE_REQUIRED`. The `ref` must
  point at the file input itself.
  - A file input inside a **same-origin** frame or a shadow root works.
  - One inside a **cross-origin** frame (`f3:` prefixed) is **refused**, and says the frame is why.
    The debugger session it drives does not extend into another origin's document. Nothing about the
    ref is wrong, so a fresh snapshot will not help — there is no upload path into that frame.
- **`browser_downloads`** lists what the browser has downloaded, **with the path on disk**, so you can
  read the file afterwards. `wait: true` blocks until an in-flight transfer finishes rather than
  returning a half-written file.

## Restricted pages

`chrome://` settings pages, the extension store, the PDF viewer: `RESTRICTED_PAGE`, from navigate,
new_tab and screenshot alike. No workaround — ask the person to look, or open an `http(s)` page.

## When something works signed in and fails signed out

The failure is usually silent — a redirect, or a button that does nothing. Two cheap checks:

- `browser_click { ..., include: "console, network" }` — a 401 or 403 shows up in the network block,
  in the same reply as the click.
- `browser_issues` — the only tool that sees failures producing **no console error at all**: blocked
  third-party cookies, content-security-policy blocks, mixed content, CORS. A dropped third-party
  cookie is a very common cause of "it works when I do it by hand".

## Recipe: "it says I am signed out" / "the cookie is not sticking"

Six calls, cheapest first. Do not start by setting a cookie — you almost never need to.

**1. Be on the origin.** Cookies are scoped to the URL of the tab you are driving, so a
`browser_get_cookies` from the wrong page is an empty answer that means nothing.

```
browser_navigate { url: "https://app.example.com" }
browser_get_cookies
```

**2. Is the cookie there at all?** Three different answers, three different bugs:

| What you see | What it means |
|---|---|
| No cookie for the origin | It was never set, or it was set on a different domain |
| The cookie is there, page still logged out | The app is not reading it — look at storage, step 3 |
| The cookie is there, requests still 401 | It is not being *sent* — look at issues, step 4 |

Values come back **redacted**. You do not need to reveal them to answer any of the three.

**3. Single-page apps usually keep the token somewhere else.**

```
browser_storage
```

`localStorage` survives the tab; **`sessionStorage` dies with it**. A session that works until you
open a second tab is almost always a `sessionStorage` token.

**4. Check what the console cannot see.**

```
browser_issues
```

**A dropped third-party cookie is the single most common cause of "it works when I do it by hand"**,
and it produces no console error whatsoever. Same for a CSP block on the auth iframe.

**5. Catch the status code on the action itself.**

```
browser_click { ref: "e7", element: "Save", include: "console, network" }
```

The 401 or 403 arrives in the same reply as the click, so you never have to guess which request the
button made.

**6. To see what a stranger sees, use a private window — never the user's own session.**

```
browser_new_tab { incognito: true, url: "https://app.example.com" }
```

Its own cookie jar, its own empty storage, and closing it ends the session with nothing to clean up.
This needs the one-off "Allow in Incognito" setting a **person** has to switch on; without it you get
`INCOGNITO_BLOCKED`. Ask, and do not retry.

**Never diagnose by clearing the user's cookies or storage.** That signs them out of a browser they
are actually using, and it destroys the evidence you were sent to look at.

## Leave the session as you found it

Do not sign the user out, clear their storage, or revoke sessions to "clean up". You are a guest in
the browser they actually use.
