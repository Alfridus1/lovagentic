# CLI Command Reference

This file is generated from `node ./src/cli.js --help`. Do not edit it manually.

- Source: [src/cli.js](../src/cli.js)

## Root help

```text
Usage: lovagentic [options] [command]

Prototype CLI for steering Lovable from the local machine.

Options:
  -V, --version                                    output the version number
  -h, --help                                       display help for command

Commands:
  doctor [options]                                 Inspect the local Lovable desktop install and CLI profile.
  import-desktop-session [options]                 Copy the desktop app session files into the CLI browser profile.
  login [options]                                  Open a persistent browser profile and wait for a Lovable session.
  list [options]                                   List Lovable dashboard projects plus the visible workspace menu entries.
  create [options] <prompt>                        Generate a Lovable Build-with-URL link and optionally open it.
  mode [options] <target-url> <mode>               Switch the Lovable composer between Build and Plan.
  prompt [options] <target-url> <prompt>           Open a Lovable project page in a persistent browser and submit a prompt.
  actions [options] <target-url>                   List visible chat-side Lovable actions near the composer, such as plan approvals.
  action [options] <target-url> <label>            Click a visible chat-side Lovable action button, such as Approve or Verify it works.
  questions [options] <target-url>                 Read the visible Lovable Questions card, including its current prompt and footer actions.
  question-action [options] <target-url> <label>   Click a visible Lovable Questions-card action, such as Skip, Submit, or Next question.
  question-answer [options] <target-url> <answer>  Fill the visible Lovable Questions-card free-text field and optionally submit it.
  errors [options] <target-url>                    Read the visible Lovable runtime/build error surface, including Try to fix and Show logs.
  error-action [options] <target-url> <label>      Click a visible Lovable runtime/build error action, such as Try to fix or Show logs.
  findings [options] <target-url>                  Open Lovable's inline Security findings pane and extract the visible issues.
  chat-loop [options] <target-url> [prompt]        Optionally send a prompt, then list and click visible Lovable chat-side actions, and optionally verify.
  publish [options] <target-url>                   Publish a Lovable project and wait for the live URL to respond.
  publish-settings [options] <target-url>          Inspect or update published visibility and website info.
  domain [options] <target-url>                    Inspect or update the published project domain settings.
  toolbar [options] <target-url>                   Inspect visible project toolbar buttons and optionally open their menus.
  project-settings [options] <target-url>          Inspect or update low-risk project settings like visibility, category, badge visibility, analytics, and rename.
  knowledge [options] <target-url>                 Inspect or update project and workspace knowledge.
  workspace [options] <target-url>                 Inspect workspace and account settings surfaces without mutating them.
  git [options] <target-url>                       Inspect or manage the project's Git/GitHub connection.
  code [options] <target-url>                      Read the connected GitHub repository as a pragmatic Code-surface fallback.
  wait-for-idle [options] <target-url>             Wait until Lovable is idle: no Thinking state, no paused queue, no open questions, and no visible runtime error.
  speed [options] <target-url>                     Run Lighthouse against the current project preview as a pragmatic Speed-surface fallback.
  fidelity-loop [options] <target-url> [prompt]    Iteratively prompt, wait for idle, verify expectations, and send follow-up prompts for remaining gaps.
  verify [options] <target-url>                    Capture desktop and mobile screenshots of the live project preview.
  help [command]                                   display help for command
```

## Commands

- [`doctor`](#doctor)
- [`import-desktop-session`](#import-desktop-session)
- [`login`](#login)
- [`list`](#list)
- [`create`](#create)
- [`mode`](#mode)
- [`prompt`](#prompt)
- [`actions`](#actions)
- [`action`](#action)
- [`questions`](#questions)
- [`question-action`](#question-action)
- [`question-answer`](#question-answer)
- [`errors`](#errors)
- [`error-action`](#error-action)
- [`findings`](#findings)
- [`chat-loop`](#chat-loop)
- [`publish`](#publish)
- [`publish-settings`](#publish-settings)
- [`domain`](#domain)
- [`toolbar`](#toolbar)
- [`project-settings`](#project-settings)
- [`knowledge`](#knowledge)
- [`workspace`](#workspace)
- [`git`](#git)
- [`code`](#code)
- [`wait-for-idle`](#wait-for-idle)
- [`speed`](#speed)
- [`fidelity-loop`](#fidelity-loop)
- [`verify`](#verify)

## doctor

```text
Usage: lovagentic doctor [options]

Inspect the local Lovable desktop install and CLI profile.

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  -h, --help                    display help for command
```

## import-desktop-session

```text
Usage: lovagentic import-desktop-session [options]

Copy the desktop app session files into the CLI browser profile.

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --force                       Replace copied profile entries first (default:
                                false)
  -h, --help                    display help for command
```

## login

```text
Usage: lovagentic login [options]

Open a persistent browser profile and wait for a Lovable session.

Options:
  --profile-dir <path>  Override the CLI browser profile path
  --base-url <url>      Override the Lovable base URL (default:
                        "https://lovable.dev")
  --headless            Run headlessly instead of opening a visible browser
                        (default: false)
  --timeout-ms <ms>     How long to wait for a login session (default: 300000)
  -h, --help            display help for command
```

## list

```text
Usage: lovagentic list [options]

List Lovable dashboard projects plus the visible workspace menu entries.

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --base-url <url>              Override the Lovable base URL (default:
                                "https://lovable.dev")
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the dashboard feed to load
                                (default: 20000)
  --poll-ms <ms>                Polling interval while waiting for the dashboard
                                feed (default: 250)
  --page-size <n>               Pagination size for dashboard project requests
                                (default: 100)
  --limit <n>                   Limit human-readable rows; JSON output still
                                includes all projects
  --json                        Print the extracted dashboard state as JSON
                                (default: false)
  -h, --help                    display help for command
```

## create

```text
Usage: lovagentic create [options] <prompt>

Generate a Lovable Build-with-URL link and optionally open it.

Arguments:
  prompt                        Prompt for the new Lovable app

Options:
  -i, --image <url>             Reference image URL (default: [])
  --base-url <url>              Override the Lovable base URL (default:
                                "https://lovable.dev")
  --profile-dir <path>          Use Playwright automation with this persistent
                                profile
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --workspace <name>            Workspace name for Lovable auto-submit
  --headless                    Run automated create flow headlessly (default:
                                false)
  --wait-for-project-ms <ms>    Wait timeout for project creation (default:
                                480000)
  --keep-open                   Leave the browser open after project creation
                                (default: false)
  --no-open                     Print the URL without opening it
  --no-autosubmit               Disable autosubmit in the generated URL
  -h, --help                    display help for command
```

## mode

```text
Usage: lovagentic mode [options] <target-url> <mode>

Switch the Lovable composer between Build and Plan.

Arguments:
  target-url                    Lovable project URL
  mode                          Target mode: build or plan

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --keep-open                   Leave the browser window open after switching
                                mode (default: false)
  -h, --help                    display help for command
```

## prompt

```text
Usage: lovagentic prompt [options] <target-url> <prompt>

Open a Lovable project page in a persistent browser and submit a prompt.

Arguments:
  target-url                      Lovable project URL
  prompt                          Follow-up prompt

Options:
  --profile-dir <path>            Override the CLI browser profile path
  --seed-desktop-session          Refresh the Playwright profile from the
                                  desktop app before launch (default: false)
  --desktop-profile-dir <path>    Override the Lovable desktop profile path
  --headless                      Run headlessly instead of opening a visible
                                  browser (default: false)
  --keep-open                     Leave the browser window open after prompt
                                  submission (default: false)
  --mode <mode>                   Switch Lovable to build or plan before sending
  --verify                        Capture preview screenshots after the prompt
                                  persisted (default: false)
  --verify-output-dir <path>      Directory for post-prompt preview screenshots
                                  and summary output
  --verify-desktop-only           Only capture the desktop preview after the
                                  prompt (default: false)
  --verify-mobile-only            Only capture the mobile preview after the
                                  prompt (default: false)
  --verify-settle-ms <ms>         Extra wait time before each post-prompt
                                  screenshot (default: 4000)
  --fail-on-console               Treat preview console warnings/errors as
                                  blocking during verify (default: false)
  --expect-text <text>            Assert that preview body text contains this
                                  string (default: [])
  --forbid-text <text>            Assert that preview body text does not contain
                                  this string (default: [])
  --no-auto-split                 Send the prompt as a single Lovable message
                                  even if it looks too large
  --allow-fragment                Send a prompt even if it looks truncated or
                                  unfinished (default: false)
  --answer-question <text>        If Lovable opens a Questions card after the
                                  prompt, answer it with this text
  --question-option <label>       Question option label to target before filling
                                  free text (default: "Other")
  --question-timeout-ms <ms>      How long to wait for a delayed Questions card
                                  after the prompt (default: 8000)
  --no-wait-for-idle              Skip waiting for Lovable to become idle before
                                  post-prompt verification
  --auto-resume                   Automatically click Resume queue / Continue
                                  queue while waiting for idle (default: false)
  --idle-timeout-ms <ms>          How long to wait for Lovable to become idle
                                  before verify (default: 300000)
  --idle-poll-ms <ms>             Polling interval while waiting for Lovable to
                                  become idle (default: 3000)
  --selector <selector>           Override the prompt input selector
  --submit-selector <selector>    Override the submit button selector
  --wait-after-submit-ms <ms>     Delay before the browser closes (default:
                                  4000)
  --post-submit-timeout-ms <ms>   How long to wait for Lovable to acknowledge
                                  the prompt (default: 20000)
  --verification-timeout-ms <ms>  How long to wait for an interactive
                                  verification to be completed in a visible
                                  browser (default: 600000)
  -h, --help                      display help for command
```

## actions

```text
Usage: lovagentic actions [options] <target-url>

List visible chat-side Lovable actions near the composer, such as plan
approvals.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for visible chat-side actions
                                (default: 5000)
  --poll-ms <ms>                Polling interval while waiting for visible
                                chat-side actions (default: 250)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## action

```text
Usage: lovagentic action [options] <target-url> <label>

Click a visible chat-side Lovable action button, such as Approve or Verify it
works.

Arguments:
  target-url                    Lovable project URL
  label                         Visible action label or aria-label

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --keep-open                   Leave the browser window open after clicking
                                (default: false)
  --exact                       Require an exact case-insensitive label match
                                (default: false)
  --index <n>                   Zero-based match index if more than one action
                                label matches (default: 0)
  --timeout-ms <ms>             How long to wait for the action click (default:
                                15000)
  --actions-timeout-ms <ms>     How long to wait for visible chat-side actions
                                before and after the click (default: 5000)
  --actions-poll-ms <ms>        Polling interval while waiting for visible
                                chat-side actions (default: 250)
  --settle-ms <ms>              Extra wait time after the click before reading
                                the page again (default: 1500)
  -h, --help                    display help for command
```

## questions

```text
Usage: lovagentic questions [options] <target-url>

Read the visible Lovable Questions card, including its current prompt and footer
actions.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the Questions card
                                (default: 5000)
  --poll-ms <ms>                Polling interval while waiting for the Questions
                                card (default: 250)
  --json                        Print the extracted Questions card state as JSON
                                (default: false)
  -h, --help                    display help for command
```

## question-action

```text
Usage: lovagentic question-action [options] <target-url> <label>

Click a visible Lovable Questions-card action, such as Skip, Submit, or Next
question.

Arguments:
  target-url                    Lovable project URL
  label                         Visible question action label or aria-label

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --exact                       Require an exact case-insensitive label match
                                (default: false)
  --index <n>                   Zero-based match index if more than one question
                                action label matches (default: 0)
  --timeout-ms <ms>             How long to wait for the question action click
                                (default: 15000)
  --actions-timeout-ms <ms>     How long to wait for visible question actions
                                before and after the click (default: 5000)
  --actions-poll-ms <ms>        Polling interval while waiting for visible
                                question actions (default: 250)
  --settle-ms <ms>              Extra wait time after the click before reading
                                the question card again (default: 1500)
  -h, --help                    display help for command
```

## question-answer

```text
Usage: lovagentic question-answer [options] <target-url> <answer>

Fill the visible Lovable Questions-card free-text field and optionally submit
it.

Arguments:
  target-url                     Lovable project URL
  answer                         Answer text for the current free-text question

Options:
  --profile-dir <path>           Override the CLI browser profile path
  --seed-desktop-session         Refresh the Playwright profile from the desktop
                                 app before launch (default: false)
  --desktop-profile-dir <path>   Override the Lovable desktop profile path
  --headless                     Run headlessly instead of opening a visible
                                 browser (default: false)
  --option <label>               Question option label to target before filling
                                 free text (default: "Other")
  --timeout-ms <ms>              How long to wait for the question field
                                 (default: 15000)
  --settle-ms <ms>               Extra wait time after clicking Submit (default:
                                 1500)
  --actions-timeout-ms <ms>      How long to wait for the question card before
                                 and after submit (default: 5000)
  --actions-poll-ms <ms>         Polling interval while waiting for the question
                                 card (default: 250)
  --chat-accept-timeout-ms <ms>  How long to wait for Lovable to accept the
                                 answer on the server (default: 30000)
  --no-submit                    Only fill the free-text field; do not click
                                 Submit
  -h, --help                     display help for command
```

## errors

```text
Usage: lovagentic errors [options] <target-url>

Read the visible Lovable runtime/build error surface, including Try to fix and
Show logs.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the runtime error surface
                                (default: 8000)
  --poll-ms <ms>                Polling interval while waiting for the runtime
                                error surface (default: 250)
  --json                        Print the extracted runtime error state as JSON
                                (default: false)
  -h, --help                    display help for command
```

## error-action

```text
Usage: lovagentic error-action [options] <target-url> <label>

Click a visible Lovable runtime/build error action, such as Try to fix or Show
logs.

Arguments:
  target-url                     Lovable project URL
  label                          Visible runtime error action label

Options:
  --profile-dir <path>           Override the CLI browser profile path
  --seed-desktop-session         Refresh the Playwright profile from the desktop
                                 app before launch (default: false)
  --desktop-profile-dir <path>   Override the Lovable desktop profile path
  --headless                     Run headlessly instead of opening a visible
                                 browser (default: false)
  --exact                        Require an exact case-insensitive label match
                                 (default: false)
  --index <n>                    Zero-based match index if more than one runtime
                                 error action label matches (default: 0)
  --timeout-ms <ms>              How long to wait for the error action click
                                 (default: 15000)
  --actions-timeout-ms <ms>      How long to wait for visible runtime error
                                 actions before and after the click (default:
                                 8000)
  --actions-poll-ms <ms>         Polling interval while waiting for visible
                                 runtime error actions (default: 250)
  --settle-ms <ms>               Extra wait time after the click before reading
                                 the page again (default: 1500)
  --chat-accept-timeout-ms <ms>  How long to wait for Lovable to accept a Try to
                                 fix recovery request on the server (default:
                                 30000)
  -h, --help                     display help for command
```

## findings

```text
Usage: lovagentic findings [options] <target-url>

Open Lovable's inline Security findings pane and extract the visible issues.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --keep-open                   Leave the browser window open after extraction
                                (default: false)
  --current-only                Only read the current page state; do not click
                                View findings automatically (default: false)
  --timeout-ms <ms>             How long to wait for the findings pane (default:
                                15000)
  --poll-ms <ms>                Polling interval while waiting for the findings
                                pane (default: 250)
  --settle-ms <ms>              Extra wait time after clicking View findings
                                (default: 1500)
  --actions-timeout-ms <ms>     How long to wait for the surrounding chat-side
                                actions (default: 5000)
  --actions-poll-ms <ms>        Polling interval while waiting for surrounding
                                chat-side actions (default: 250)
  --json                        Print the extracted findings as JSON (default:
                                false)
  -h, --help                    display help for command
```

## chat-loop

```text
Usage: lovagentic chat-loop [options] <target-url> [prompt]

Optionally send a prompt, then list and click visible Lovable chat-side actions,
and optionally verify.

Arguments:
  target-url                      Lovable project URL
  prompt                          Optional follow-up prompt to send before
                                  processing actions

Options:
  --profile-dir <path>            Override the CLI browser profile path
  --seed-desktop-session          Refresh the Playwright profile from the
                                  desktop app before launch (default: false)
  --desktop-profile-dir <path>    Override the Lovable desktop profile path
  --headless                      Run headlessly instead of opening a visible
                                  browser (default: false)
  --keep-open                     Leave the browser window open after the loop
                                  completes (default: false)
  --mode <mode>                   Switch Lovable to build or plan before sending
  --action <label>                Click this visible chat-side action after the
                                  prompt (default: [])
  --exact-action                  Require exact case-insensitive matching for
                                  --action labels (default: false)
  --action-index <n>              Zero-based match index if more than one action
                                  label matches (default: 0)
  --wait-for-actions-ms <ms>      How long to wait for visible chat-side actions
                                  between loop steps (default: 10000)
  --action-poll-ms <ms>           Polling interval while waiting for visible
                                  chat-side actions (default: 250)
  --action-settle-ms <ms>         Extra wait time after each action click before
                                  reading again (default: 1500)
  --selector <selector>           Override the prompt input selector
  --submit-selector <selector>    Override the submit button selector
  --post-submit-timeout-ms <ms>   How long to wait for Lovable to acknowledge
                                  the prompt (default: 20000)
  --verification-timeout-ms <ms>  How long to wait for an interactive
                                  verification to be completed in a visible
                                  browser (default: 600000)
  --verify                        Capture preview screenshots after the loop
                                  completes (default: false)
  --verify-output-dir <path>      Directory for post-loop preview screenshots
                                  and summary output
  --verify-desktop-only           Only capture the desktop preview after the
                                  loop (default: false)
  --verify-mobile-only            Only capture the mobile preview after the loop
                                  (default: false)
  --verify-settle-ms <ms>         Extra wait time before each post-loop
                                  screenshot (default: 4000)
  --fail-on-console               Treat preview console warnings/errors as
                                  blocking during verify (default: false)
  --expect-text <text>            Assert that preview body text contains this
                                  string (default: [])
  --forbid-text <text>            Assert that preview body text does not contain
                                  this string (default: [])
  --no-auto-split                 Send the prompt as a single Lovable message
                                  even if it looks too large
  --allow-fragment                Send a prompt even if it looks truncated or
                                  unfinished (default: false)
  --answer-question <text>        If Lovable opens a Questions card after the
                                  prompt, answer it with this text
  --question-option <label>       Question option label to target before filling
                                  free text (default: "Other")
  --question-timeout-ms <ms>      How long to wait for a delayed Questions card
                                  after the prompt (default: 8000)
  --no-wait-for-idle              Skip waiting for Lovable to become idle before
                                  post-loop verification
  --auto-resume                   Automatically click Resume queue / Continue
                                  queue while waiting for idle (default: false)
  --idle-timeout-ms <ms>          How long to wait for Lovable to become idle
                                  before verify (default: 300000)
  --idle-poll-ms <ms>             Polling interval while waiting for Lovable to
                                  become idle (default: 3000)
  --wait-after-loop-ms <ms>       Delay before the browser closes after the loop
                                  (default: 4000)
  -h, --help                      display help for command
```

## publish

```text
Usage: lovagentic publish [options] <target-url>

Publish a Lovable project and wait for the live URL to respond.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --keep-open                   Leave the browser window open after publishing
                                (default: false)
  --timeout-ms <ms>             How long to wait for Lovable to finish
                                publishing (default: 420000)
  --live-url-timeout-ms <ms>    How long to wait for the live site URL to return
                                success (default: 300000)
  --poll-ms <ms>                Polling interval while waiting for the live site
                                (default: 3000)
  --verify-live                 Capture screenshots and summary output against
                                the published live URL (default: false)
  --verify-output-dir <path>    Directory for post-publish live screenshots and
                                summary output
  --verify-desktop-only         Only capture the desktop live site (default:
                                false)
  --verify-mobile-only          Only capture the mobile live site (default:
                                false)
  --verify-settle-ms <ms>       Extra wait time before each live-site screenshot
                                (default: 4000)
  --fail-on-console             Treat live-site console warnings/errors as
                                blocking during verify (default: false)
  --expect-text <text>          Assert that live-site body text contains this
                                string (default: [])
  --forbid-text <text>          Assert that live-site body text does not contain
                                this string (default: [])
  -h, --help                    display help for command
```

## publish-settings

```text
Usage: lovagentic publish-settings [options] <target-url>

Inspect or update published visibility and website info.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the settings surfaces
                                (default: 90000)
  --visibility <scope>          Set publish visibility (public, workspace,
                                selected)
  --title <text>                Set the published website title
  --description <text>          Set the published website description
  -h, --help                    display help for command
```

## domain

```text
Usage: lovagentic domain [options] <target-url>

Inspect or update the published project domain settings.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the domain settings page
                                (default: 120000)
  --live-url-timeout-ms <ms>    How long to wait for the updated live URL to
                                return success (default: 300000)
  --poll-ms <ms>                Polling interval while waiting for the updated
                                live URL (default: 3000)
  --subdomain <slug>            Update the default .lovable.app subdomain
  --connect <fqdn>              Connect a custom domain like example.com or
                                www.example.com
  --advanced                    Open the advanced section in the custom-domain
                                dialog before submitting (default: false)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## toolbar

```text
Usage: lovagentic toolbar [options] <target-url>

Inspect visible project toolbar buttons and optionally open their menus.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --menu <label>                Open a specific toolbar menu button by visible
                                label (default: [])
  --timeout-ms <ms>             How long to wait for toolbar menus and buttons
                                (default: 20000)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## project-settings

```text
Usage: lovagentic project-settings [options] <target-url>

Inspect or update low-risk project settings like visibility, category, badge
visibility, analytics, and rename.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the project settings page
                                (default: 90000)
  --visibility <scope>          Set project visibility (public, workspace,
                                restricted-business)
  --category <name>             Set project category
  --hide-lovable-badge <state>  Set Hide Lovable badge to true/false
  --disable-analytics <state>   Set Disable analytics to true/false
  --rename <name>               Rename the project
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## knowledge

```text
Usage: lovagentic knowledge [options] <target-url>

Inspect or update project and workspace knowledge.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for the knowledge settings page
                                (default: 90000)
  --project-text <text>         Set the project knowledge text
  --workspace-text <text>       Set the workspace knowledge text
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## workspace

```text
Usage: lovagentic workspace [options] <target-url>

Inspect workspace and account settings surfaces without mutating them.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --section <name>              Workspace settings section to inspect (default:
                                "all")
  --timeout-ms <ms>             How long to wait for each workspace settings
                                page (default: 90000)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## git

```text
Usage: lovagentic git [options] <target-url>

Inspect or manage the project's Git/GitHub connection.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --provider <name>             Git provider to inspect (default: "github")
  --timeout-ms <ms>             How long to wait for the git settings flow
                                (default: 90000)
  --connect                     Connect the provider for this project (default:
                                false)
  --disconnect                  Disconnect the provider for this project
                                (default: false)
  --reconnect                   Reconnect the provider for this project
                                (default: false)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## code

```text
Usage: lovagentic code [options] <target-url>

Read the connected GitHub repository as a pragmatic Code-surface fallback.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --provider <name>             Git provider to inspect before reading code
                                (default: "github")
  --file <path>                 Read a specific file from the connected
                                repository
  --search <query>              Search code in the connected repository
  --download                    Write the requested file content to disk;
                                requires --file (default: false)
  --output-path <path>          Where to write the downloaded file content
  --limit <n>                   Limit tree or search output (default: 200)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## wait-for-idle

```text
Usage: lovagentic wait-for-idle [options] <target-url>

Wait until Lovable is idle: no Thinking state, no paused queue, no open
questions, and no visible runtime error.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --timeout-ms <ms>             How long to wait for Lovable to become idle
                                (default: 300000)
  --poll-ms <ms>                Polling interval while waiting for Lovable to
                                become idle (default: 3000)
  --auto-resume                 Automatically click Resume queue / Continue
                                queue while waiting for idle (default: false)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## speed

```text
Usage: lovagentic speed [options] <target-url>

Run Lighthouse against the current project preview as a pragmatic Speed-surface
fallback.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --device <name>               Audit desktop, mobile, or both (default: "both")
  --output-dir <path>           Directory for Lighthouse JSON reports
  --no-wait-for-idle            Skip waiting for Lovable to become idle before
                                the audit
  --auto-resume                 Automatically click Resume queue / Continue
                                queue while waiting for idle (default: false)
  --idle-timeout-ms <ms>        How long to wait for Lovable to become idle
                                before the audit (default: 300000)
  --idle-poll-ms <ms>           Polling interval while waiting for Lovable to
                                become idle (default: 3000)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## fidelity-loop

```text
Usage: lovagentic fidelity-loop [options] <target-url> [prompt]

Iteratively prompt, wait for idle, verify expectations, and send follow-up
prompts for remaining gaps.

Arguments:
  target-url                    Lovable project URL
  prompt                        Optional initial prompt

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --headless                    Run headlessly instead of opening a visible
                                browser (default: false)
  --prompt-file <path>          Read the initial prompt from a local file
  --mode <mode>                 Switch Lovable to build or plan before sending
                                prompts
  --expect-text <text>          Assert that preview body text contains this
                                string (default: [])
  --forbid-text <text>          Assert that preview body text does not contain
                                this string (default: [])
  --expect-file <path>          Read required preview assertions from a file,
                                one per non-empty line
  --forbid-file <path>          Read forbidden preview assertions from a file,
                                one per non-empty line
  --max-iterations <n>          Maximum prompt/verify iterations before stopping
                                (default: 3)
  --output-dir <path>           Directory for iteration summaries and
                                screenshots
  --desktop-only                Only capture the desktop preview (default:
                                false)
  --mobile-only                 Only capture the mobile preview (default: false)
  --settle-ms <ms>              Extra wait time before each screenshot (default:
                                4000)
  --fail-on-console             Treat preview console warnings/errors as
                                blocking (default: false)
  --no-auto-split               Send prompts as single Lovable messages even if
                                they look too large
  --allow-fragment              Send prompts even if they look truncated or
                                unfinished (default: false)
  --auto-resume                 Automatically click Resume queue / Continue
                                queue while waiting for idle (default: false)
  --idle-timeout-ms <ms>        How long to wait for Lovable to become idle
                                before each verification (default: 300000)
  --idle-poll-ms <ms>           Polling interval while waiting for Lovable to
                                become idle (default: 3000)
  --json                        Print machine-readable JSON (default: false)
  -h, --help                    display help for command
```

## verify

```text
Usage: lovagentic verify [options] <target-url>

Capture desktop and mobile screenshots of the live project preview.

Arguments:
  target-url                    Lovable project URL

Options:
  --profile-dir <path>          Override the CLI browser profile path
  --seed-desktop-session        Refresh the Playwright profile from the desktop
                                app before launch (default: false)
  --desktop-profile-dir <path>  Override the Lovable desktop profile path
  --output-dir <path>           Directory for preview screenshots and summary
                                output
  --desktop-only                Only capture the desktop preview (default:
                                false)
  --mobile-only                 Only capture the mobile preview (default: false)
  --headed                      Run the extraction and preview captures visibly
                                (default: false)
  --no-wait-for-idle            Skip waiting for Lovable to become idle before
                                preview capture
  --auto-resume                 Automatically click Resume queue / Continue
                                queue while waiting for idle (default: false)
  --idle-timeout-ms <ms>        How long to wait for Lovable to become idle
                                before preview capture (default: 300000)
  --idle-poll-ms <ms>           Polling interval while waiting for Lovable to
                                become idle (default: 3000)
  --settle-ms <ms>              Extra wait time before each screenshot (default:
                                4000)
  --fail-on-console             Treat preview console warnings/errors as
                                blocking (default: false)
  --expect-text <text>          Assert that preview body text contains this
                                string (default: [])
  --forbid-text <text>          Assert that preview body text does not contain
                                this string (default: [])
  -h, --help                    display help for command
```
