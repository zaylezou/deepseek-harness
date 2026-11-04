# Publishing
Publishing messages can be done via HTTP PUT/POST or via the [ntfy CLI](subscribe/cli.md#publish-messages) ([install instructions](install.md)).
Topics are created on the fly by subscribing or publishing to them. Because there is no sign-up, **the topic is essentially a password**, so pick
something that's not easily guessable (see [picking a topic](#picking-a-topic) for a handy topic name generator).

Here's an example showing how to publish a simple message using a POST request:

=== "Command line (curl)"
    ```
    curl -d "Backup successful 😀" ntfy.sh/mytopic
    ```

=== "ntfy CLI"
    ```
    ntfy publish mytopic "Backup successful 😀"
    ```

=== "HTTP"
    ``` http
    POST /mytopic HTTP/1.1
    Host: ntfy.sh

    Backup successful 😀
    ```
=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/mytopic', {
      method: 'POST', // PUT works too
      body: 'Backup successful 😀'
    })
    ```

=== "Go"
    ``` go
    http.Post("https://ntfy.sh/mytopic", "text/plain",
        strings.NewReader("Backup successful 😀"))
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/mytopic"
      Body = "Backup successful"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/mytopic",
        data="Backup successful 😀".encode(encoding='utf-8'))
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/mytopic', false, stream_context_create([
        'http' => [
            'method' => 'POST', // PUT also works
            'header' => 'Content-Type: text/plain',
            'content' => 'Backup successful 😀'
        ]
    ]));
    ```

If you have the [Android app](subscribe/phone.md) installed on your phone, this will create a notification that looks like this:

<figure markdown>
  ![basic notification](static/img/android-screenshot-basic-notification.png){ width=500 }
  <figcaption>Android notification</figcaption>
</figure>

There are more features related to publishing messages: You can set a [notification priority](#message-priority),
a [title](#message-title), and [tag messages](#tags-emojis) 🥳 🎉. Here's an example that uses some of them at together:

=== "Command line (curl)"
    ```
    curl \
      -H "Title: Unauthorized access detected" \
      -H "Priority: urgent" \
      -H "Tags: warning,skull" \
      -d "Remote access to phils-laptop detected. Act right away." \
      ntfy.sh/phil_alerts
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --title "Unauthorized access detected" \
        --tags warning,skull \
        --priority urgent \
        mytopic \
        "Remote access to phils-laptop detected. Act right away."
    ```

=== "HTTP"
    ``` http
    POST /phil_alerts HTTP/1.1
    Host: ntfy.sh
    Title: Unauthorized access detected
    Priority: urgent
    Tags: warning,skull

    Remote access to phils-laptop detected. Act right away.
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/phil_alerts', {
        method: 'POST', // PUT works too
        body: 'Remote access to phils-laptop detected. Act right away.',
        headers: {
            'Title': 'Unauthorized access detected',
            'Priority': 'urgent',
            'Tags': 'warning,skull'
        }
    })
    ```

=== "Go"
    ``` go
	req, _ := http.NewRequest("POST", "https://ntfy.sh/phil_alerts",
		strings.NewReader("Remote access to phils-laptop detected. Act right away."))
	req.Header.Set("Title", "Unauthorized access detected")
	req.Header.Set("Priority", "urgent")
	req.Header.Set("Tags", "warning,skull")
	http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/phil_alerts"
      Headers = @{
        Title = "Unauthorized access detected"
        Priority = "urgent"
        Tags = "warning,skull"
      }
      Body = "Remote access to phils-laptop detected. Act right away."
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/phil_alerts",
        data="Remote access to phils-laptop detected. Act right away.",
        headers={
            "Title": "Unauthorized access detected",
            "Priority": "urgent",
            "Tags": "warning,skull"
        })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/phil_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST', // PUT also works
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Title: Unauthorized access detected\r\n" .
                "Priority: urgent\r\n" .
                "Tags: warning,skull",
            'content' => 'Remote access to phils-laptop detected. Act right away.'
        ]
    ]));
    ```

<figure markdown>
  ![priority notification](static/img/priority-notification.png){ width=500 }
  <figcaption>Urgent notification with tags and title</figcaption>
</figure>

You can also do multi-line messages. Here's an example using a [click action](#click-action), an [action button](#action-buttons),
an [external image attachment](#attach-file-from-a-url) and [email publishing](#e-mail-publishing):

=== "Command line (curl)"
    ```
    curl \
      -H "Click: https://home.nest.com/" \
      -H "Attach: https://nest.com/view/yAxkasd.jpg" \
      -H "Actions: http, Open door, https://api.nest.com/open/yAxkasd, clear=true" \
      -H "Email: phil@example.com" \
      -d "There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell." \
      ntfy.sh/mydoorbell
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
	    --click="https://home.nest.com/" \
        --attach="https://nest.com/view/yAxkasd.jpg" \
        --actions="http, Open door, https://api.nest.com/open/yAxkasd, clear=true" \
        --email="phil@example.com" \
        mydoorbell \
        "There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell."
    ```

=== "HTTP"
    ``` http
    POST /mydoorbell HTTP/1.1
    Host: ntfy.sh
    Click: https://home.nest.com/
    Attach: https://nest.com/view/yAxkasd.jpg
    Actions: http, Open door, https://api.nest.com/open/yAxkasd, clear=true
    Email: phil@example.com

    There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell.
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/mydoorbell', {
        method: 'POST', // PUT works too
        headers: {
            'Click': 'https://home.nest.com/',
            'Attach': 'https://nest.com/view/yAxkasd.jpg',
	        'Actions': 'http, Open door, https://api.nest.com/open/yAxkasd, clear=true',
	        'Email': 'phil@example.com'
        },
        body: `There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell.`,
    })
    ```

=== "Go"
    ``` go
	req, _ := http.NewRequest("POST", "https://ntfy.sh/mydoorbell",
		strings.NewReader(`There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell.`))
	req.Header.Set("Click", "https://home.nest.com/")
	req.Header.Set("Attach", "https://nest.com/view/yAxkasd.jpg")
	req.Header.Set("Actions", "http, Open door, https://api.nest.com/open/yAxkasd, clear=true")
	req.Header.Set("Email", "phil@example.com")
	http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/mydoorbell"
      Headers = @{
        Click = "https://home.nest.com"
        Attach = "https://nest.com/view/yAxksd.jpg"
        Actions = "http, Open door, https://api.nest.com/open/yAxkasd, clear=true"
        Email = "phil@example.com"
      }
      Body = "There's someone at the door. 🐶`n
      `n
      Please check if it's a good boy or a hooman.`n
      Doggies have been known to ring the doorbell.`n"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/mydoorbell",
        data="""There's someone at the door. 🐶

    Please check if it's a good boy or a hooman.
    Doggies have been known to ring the doorbell.""".encode('utf-8'),
        headers={
            "Click": "https://home.nest.com/",
            "Attach": "https://nest.com/view/yAxkasd.jpg",
            "Actions": "http, Open door, https://api.nest.com/open/yAxkasd, clear=true",
            "Email": "phil@example.com"
        })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/mydoorbell', false, stream_context_create([
        'http' => [
            'method' => 'POST', // PUT also works
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Click: https://home.nest.com/\r\n" .
                "Attach: https://nest.com/view/yAxkasd.jpg\r\n" .
                "Actions": "http, Open door, https://api.nest.com/open/yAxkasd, clear=true\r\n" .
                "Email": "phil@example.com\r\n",
            'content' => 'There\'s someone at the door. 🐶

    Please check if it\'s a good boy or a hooman.
    Doggies have been known to ring the doorbell.'
        ]
    ]));
    ```

<figure markdown>
  ![priority notification](static/img/android-screenshot-notification-multiline.jpg){ width=500 }
  <figcaption>Notification using a click action, a user action, with an external image attachment and forwarded via email</figcaption>
</figure>

## Picking a topic
Since there is no sign-up, **the topic is essentially a password**, so pick something that's not easily guessable. Topic names may
only contain letters, numbers, underscores and dashes (`[-_A-Za-z0-9]`), and may be up to 64 characters long.

Not sure what to pick? Type a name below and the generator will add a random, hard-to-guess suffix for you. Everything happens locally in your browser:

<div id="tg-widget" class="tg-generator">
<div class="tg-header">
<span class="tg-title">Topic name generator</span>
<button type="button" id="tg-reroll" class="tg-reset" title="Generate a new random suffix">Regenerate suffix</button>
</div>
<div class="tg-body">
<div class="tg-left">
<div class="tg-field">
<label for="tg-input">Type a topic name</label>
<input type="text" id="tg-input" placeholder="e.g. backups, alerts, phil-home" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
</div>
<div class="tg-note">Spaces and characters other than letters, numbers, <code>-</code> and <code>_</code> are removed automatically as you type. Names are capped at 64 characters.</div>
</div>
<div class="tg-right">
<div class="tg-output-row">
<span class="tg-output-label">Your topic:</span>
<div class="tg-output-line">
<pre class="tg-output" id="tg-output-name"></pre>
<button type="button" class="tg-btn-copy" data-copy="tg-output-name" title="Copy to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
</div>
</div>
<div class="tg-output-row">
<span class="tg-output-label">Your topic URL:</span>
<div class="tg-output-line">
<pre class="tg-output" id="tg-output-url">https://ntfy.sh/</pre>
<button type="button" class="tg-btn-copy" data-copy="tg-output-url" title="Copy to clipboard"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
</div>
</div>
</div>
</div>
</div>

## Message title
_Supported on:_ :material-android: :material-apple: :material-firefox:

The notification title is typically set to the topic short URL (e.g. `ntfy.sh/mytopic`). To override the title,
you can set the `X-Title` header (or any of its aliases: `Title`, `ti`, or `t`).

=== "Command line (curl)"
    ```
    curl -H "X-Title: Dogs are better than cats" -d "Oh my ..." ntfy.sh/controversial
    curl -H "Title: Dogs are better than cats" -d "Oh my ..." ntfy.sh/controversial
    curl -H "t: Dogs are better than cats" -d "Oh my ..." ntfy.sh/controversial
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        -t "Dogs are better than cats" \
        controversial "Oh my ..."
    ```

=== "HTTP"
    ``` http
    POST /controversial HTTP/1.1
    Host: ntfy.sh
    Title: Dogs are better than cats

    Oh my ...
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/controversial', {
        method: 'POST',
        body: 'Oh my ...',
        headers: { 'Title': 'Dogs are better than cats' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/controversial", strings.NewReader("Oh my ..."))
    req.Header.Set("Title", "Dogs are better than cats")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/controversial"
      Headers = @{
        Title = "Dogs are better than cats"
      }
      Body = "Oh my ..."
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/controversial",
        data="Oh my ...",
        headers={ "Title": "Dogs are better than cats" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/controversial', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Title: Dogs are better than cats",
            'content' => 'Oh my ...'
        ]
    ]));
    ```

<figure markdown>
  ![notification with title](static/img/notification-with-title.png){ width=500 }
  <figcaption>Detail view of notification with title</figcaption>
</figure>

!!! info
    ntfy supports UTF-8 in HTTP headers, but [not every library or programming language does](https://www.jmix.io/blog/utf-8-in-http-headers/).
    If non-ASCII characters are causing issues for you in the title (i.e. you're seeing `?` symbols), you may also encode any header (including the title)
    as [RFC 2047](https://datatracker.ietf.org/doc/html/rfc2047#section-2), e.g. `=?UTF-8?B?8J+HqfCfh6o=?=` ([base64](https://en.wikipedia.org/wiki/Base64)),
    or `=?UTF-8?Q?=C3=84pfel?=` ([quoted-printable](https://en.wikipedia.org/wiki/Quoted-printable)).

## Message priority
_Supported on:_ :material-android: :material-apple: :material-firefox:

All messages have a priority, which defines how urgently your phone notifies you. On Android, you can set custom
notification sounds and vibration patterns on your phone to map to these priorities (see [Android config](subscribe/phone.md)).

The following priorities exist:

| Priority             | Icon                                       | ID  | Name           | Description                                                                                            |
|----------------------|--------------------------------------------|-----|----------------|--------------------------------------------------------------------------------------------------------|
| Max priority         | ![min priority](static/img/priority-5.svg) | `5` | `max`/`urgent` | Really long vibration bursts, default notification sound with a pop-over notification.                 |
| High priority        | ![min priority](static/img/priority-4.svg) | `4` | `high`         | Long vibration burst, default notification sound with a pop-over notification.                         |
| **Default priority** | *(none)*                                   | `3` | `default`      | Short default vibration and sound. Default notification behavior.                                      |
| Low priority         | ![min priority](static/img/priority-2.svg) | `2` | `low`          | No vibration or sound. Notification will not visibly show up until notification drawer is pulled down. |
| Min priority         | ![min priority](static/img/priority-1.svg) | `1` | `min`          | No vibration or sound. The notification will be under the fold in "Other notifications".               |

You can set the priority with the header `X-Priority` (or any of its aliases: `Priority`, `prio`, or `p`).

=== "Command line (curl)"
    ```
    curl -H "X-Priority: 5" -d "An urgent message" ntfy.sh/phil_alerts
    curl -H "Priority: low" -d "Low priority message" ntfy.sh/phil_alerts
    curl -H p:4 -d "A high priority message" ntfy.sh/phil_alerts
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        -p 5 \
        phil_alerts An urgent message
    ```

=== "HTTP"
    ``` http
    POST /phil_alerts HTTP/1.1
    Host: ntfy.sh
    Priority: 5

    An urgent message
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/phil_alerts', {
        method: 'POST',
        body: 'An urgent message',
        headers: { 'Priority': '5' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/phil_alerts", strings.NewReader("An urgent message"))
    req.Header.Set("Priority", "5")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = 'POST'
      URI = "https://ntfy.sh/phil_alerts"
      Headers = @{
        Priority = "5"
      }
      Body = "An urgent message"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/phil_alerts",
        data="An urgent message",
        headers={ "Priority": "5" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/phil_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Priority: 5",
            'content' => 'An urgent message'
        ]
    ]));
    ```

<figure markdown>
  ![priority notification](static/img/priority-detail-overview.png){ width=500 }
  <figcaption>Detail view of priority notifications</figcaption>
</figure>

## Tags & emojis 🥳 🎉
_Supported on:_ :material-android: :material-apple: :material-firefox:

You can tag messages with emojis and other relevant strings:

* **Emojis**: If a tag matches an [emoji short code](emojis.md), it'll be converted to an emoji and prepended
  to title or message.
* **Other tags:** If a tag doesn't match, it will be listed below the notification.

This feature is useful for things like warnings (⚠️, ️🚨, or 🚩), but also to simply tag messages otherwise (e.g. script
names, hostnames, etc.). Use [the emoji short code list](emojis.md) to figure out what tags can be converted to emojis.
Here's an **excerpt of emojis** I've found very useful in alert messages:

<table class="remove-md-box"><tr>
<td>
    <table><thead><tr><th>Tag</th><th>Emoji</th></tr></thead><tbody>
    <tr><td><code>+1</code></td><td>👍</td></tr>
    <tr><td><code>partying_face</code></td><td>🥳</td></tr>
    <tr><td><code>tada</code></td><td>🎉</td></tr>
    <tr><td><code>heavy_check_mark</code></td><td>✔️</td></tr>
    <tr><td><code>loudspeaker</code></td><td>📢</td></tr>
    <tr><td>...</td><td>...</td></tr>
    </tbody></table>
</td>
<td>
    <table><thead><tr><th>Tag</th><th>Emoji</th></tr></thead><tbody>
    <tr><td><code>-1</code></td><td>👎️</td></tr>
    <tr><td><code>warning</code></td><td>⚠️</td></tr>
    <tr><td><code>rotating_light</code></td><td>️🚨</td></tr>
    <tr><td><code>triangular_flag_on_post</code></td><td>🚩</td></tr>
    <tr><td><code>skull</code></td><td>💀</td></tr>
    <tr><td>...</td><td>...</td></tr>
    </tbody></table>
</td>
<td>
    <table><thead><tr><th>Tag</th><th>Emoji</th></tr></thead><tbody>
    <tr><td><code>facepalm</code></td><td>🤦</td></tr>
    <tr><td><code>no_entry</code></td><td>⛔</td></tr>
    <tr><td><code>no_entry_sign</code></td><td>🚫</td></tr>
    <tr><td><code>cd</code></td><td>💿</td></tr>
    <tr><td><code>computer</code></td><td>💻</td></tr>
    <tr><td>...</td><td>...</td></tr>
    </tbody></table>
</td>
</tr></table>

You can set tags with the `X-Tags` header (or any of its aliases: `Tags`, `tag`, or `ta`). Specify multiple tags by separating
them with a comma, e.g. `tag1,tag2,tag3`.

=== "Command line (curl)"
    ```
    curl -H "X-Tags: warning,mailsrv13,daily-backup" -d "Backup of mailsrv13 failed" ntfy.sh/backups
    curl -H "Tags: horse,unicorn" -d "Unicorns are just horses with unique horns" ntfy.sh/backups
    curl -H ta:dog -d "Dogs are awesome" ntfy.sh/backups
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --tags=warning,mailsrv13,daily-backup \
        backups "Backup of mailsrv13 failed"
    ```

=== "HTTP"
    ``` http
    POST /backups HTTP/1.1
    Host: ntfy.sh
    Tags: warning,mailsrv13,daily-backup

    Backup of mailsrv13 failed
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/backups', {
        method: 'POST',
        body: 'Backup of mailsrv13 failed',
        headers: { 'Tags': 'warning,mailsrv13,daily-backup' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/backups", strings.NewReader("Backup of mailsrv13 failed"))
    req.Header.Set("Tags", "warning,mailsrv13,daily-backup")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/backups"
      Headers = @{
        Tags = "warning,mailsrv13,daily-backup"
      }
      Body = "Backup of mailsrv13 failed"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/backups",
        data="Backup of mailsrv13 failed",
        headers={ "Tags": "warning,mailsrv13,daily-backup" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/backups', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Tags: warning,mailsrv13,daily-backup",
            'content' => 'Backup of mailsrv13 failed'
        ]
    ]));
    ```

<figure markdown>
  ![priority notification](static/img/notification-with-tags.png){ width=500 }
  <figcaption>Detail view of notifications with tags</figcaption>
</figure>

!!! info
    ntfy supports UTF-8 in HTTP headers, but [not every library or programming language does](https://www.jmix.io/blog/utf-8-in-http-headers/).
    If non-ASCII characters are causing issues for you in the title (i.e. you're seeing `?` symbols), you may also encode the tags header or individual tags
    as [RFC 2047](https://datatracker.ietf.org/doc/html/rfc2047#section-2), e.g. `tag1,=?UTF-8?B?8J+HqfCfh6o=?=` ([base64](https://en.wikipedia.org/wiki/Base64)),
    or `=?UTF-8?Q?=C3=84pfel?=,tag2` ([quoted-printable](https://en.wikipedia.org/wiki/Quoted-printable)).

## Markdown formatting
_Supported on:_ :material-android: :material-firefox:

You can format messages using [Markdown](https://www.markdownguide.org/basic-syntax/) 🤩. That means you can use
**bold text**, *italicized text*, links, images, and more. Supported Markdown features:

- [Emphasis](https://www.markdownguide.org/basic-syntax/#emphasis) such as **bold** (`**bold**`), *italics* (`*italics*`)
- [Links](https://www.markdownguide.org/basic-syntax/#links) (`[some tool](https://ntfy.sh)`)
- [Images](https://www.markdownguide.org/basic-syntax/#images) (`![some image](https://bing.com/logo.png)`)
- [Code blocks](https://www.markdownguide.org/basic-syntax/#code-blocks) (` ```code blocks``` `) and [inline code](https://www.markdownguide.org/basic-syntax/#inline-code) (`` `inline code` ``)
- [Headings](https://www.markdownguide.org/basic-syntax/#headings) (`# headings`, `## headings`, etc.)
- [Lists](https://www.markdownguide.org/basic-syntax/#lists) (`- lists`, `1. lists`, etc.)
- [Blockquotes](https://www.markdownguide.org/basic-syntax/#blockquotes) (`> blockquotes`)
- [Horizontal rules](https://www.markdownguide.org/basic-syntax/#horizontal-rules) (`---`)

By default, messages sent to ntfy are rendered as plain text. To enable Markdown, set the `X-Markdown` header (or any of
its aliases: `Markdown`, or `md`) to `true` (or `1` or `yes`), or set the `Content-Type` header to `text/markdown`.
Here's an example of how to enable Markdown formatting:

=== "Command line (curl)"
    ```
    curl \
        -d "Look ma, **bold text**, *italics*, ..." \
        -H "Markdown: yes" \
        ntfy.sh/mytopic
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --markdown \
        mytopic \
        "Look ma, **bold text**, *italics*, ..."
    ```

=== "HTTP"
    ``` http
    POST /mytopic HTTP/1.1
    Host: ntfy.sh
    Markdown: yes

    Look ma, **bold text**, *italics*, ...
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/mytopic', {
      method: 'POST', // PUT works too
      body: 'Look ma, **bold text**, *italics*, ...',
      headers: { 'Markdown': 'yes' }
    })
    ```

=== "Go"
    ``` go
    http.Post("https://ntfy.sh/mytopic", "text/markdown",
        strings.NewReader("Look ma, **bold text**, *italics*, ..."))

    // or
    req, _ := http.NewRequest("POST", "https://ntfy.sh/mytopic",
        strings.NewReader("Look ma, **bold text**, *italics*, ..."))
    req.Header.Set("Markdown", "yes")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/mytopic"
      Body = "Look ma, **bold text**, *italics*, ..."
      Headers = @{
        Markdown = "yes"
      }
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/mytopic",
        data="Look ma, **bold text**, *italics*, ...",
        headers={ "Markdown": "yes" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/mytopic', false, stream_context_create([
        'http' => [
            'method' => 'POST', // PUT also works
            'header' => 'Content-Type: text/markdown', // !
            'content' => 'Look ma, **bold text**, *italics*, ...'
        ]
    ]));
    ```

Here's what that looks like in the web app:

<figure markdown>
  ![markdown](static/img/web-markdown.png){ width=500 }
  <figcaption>Markdown formatting in the web app</figcaption>
</figure>

## Click action
_Supported on:_ :material-android: :material-apple: :material-firefox:

You can define which URL to open when a notification is clicked. This may be useful if your notification is related
to a Zabbix alert or a transaction that you'd like to provide the deep-link for. Tapping the notification will open
the web browser (or the app) and open the website.

To define a click action for the notification, pass a URL as the value of the `X-Click` header (or its alias `Click`).
If you pass a website URL (`http://` or `https://`) the web browser will open. If you pass another URI that can be handled
by another app, the responsible app may open.

Examples:

* `http://` or `https://` will open your browser (or an app if it registered for a URL)
* `mailto:` links will open your mail app, e.g. `mailto:phil@example.com`
* `geo:` links will open Google Maps, e.g. `geo:0,0?q=1600+Amphitheatre+Parkway,+Mountain+View,+CA`
* `ntfy://` links will open ntfy (see [ntfy:// links](subscribe/phone.md#ntfy-links)), e.g. `ntfy://ntfy.sh/stats`
* `twitter://` links will open Twitter, e.g. `twitter://user?screen_name=..`
* ...

Here's an example that will open Reddit when the notification is clicked:

=== "Command line (curl)"
    ```
    curl \
        -d "New messages on Reddit" \
        -H "Click: https://www.reddit.com/message/messages" \
        ntfy.sh/reddit_alerts
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --click="https://www.reddit.com/message/messages" \
        reddit_alerts "New messages on Reddit"
    ```

=== "HTTP"
    ``` http
    POST /reddit_alerts HTTP/1.1
    Host: ntfy.sh
    Click: https://www.reddit.com/message/messages

    New messages on Reddit
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/reddit_alerts', {
        method: 'POST',
        body: 'New messages on Reddit',
        headers: { 'Click': 'https://www.reddit.com/message/messages' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/reddit_alerts", strings.NewReader("New messages on Reddit"))
    req.Header.Set("Click", "https://www.reddit.com/message/messages")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/reddit_alerts"
      Headers = @{ Click="https://www.reddit.com/message/messages" }
      Body = "New messages on Reddit"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/reddit_alerts",
        data="New messages on Reddit",
        headers={ "Click": "https://www.reddit.com/message/messages" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/reddit_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Click: https://www.reddit.com/message/messages",
            'content' => 'New messages on Reddit'
        ]
    ]));
    ```

## Icons
_Supported on:_ :material-android:

You can include an icon that will appear next to the text of the notification. Simply pass the `X-Icon` header or query
parameter (or its alias `Icon`) to specify the URL that the icon is located at. The client will automatically download
the icon (unless it is already cached locally, and less than 24 hours old), and show it in the notification. Icons are
cached locally in the client until the notification is deleted. **Only JPEG and PNG images are supported at this time**.

Here's an example showing how to include an icon:

=== "Command line (curl)"
    ```
    curl \
        -H "Icon: https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png" \
        -H "Title: Kodi: Resuming Playback" \
        -H "Tags: arrow_forward" \
        -d "The Wire, S01E01" \
        ntfy.sh/tvshows
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --icon="https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png" \
        --title="Kodi: Resuming Playback" \
        --tags="arrow_forward" \
        tvshows \
        "The Wire, S01E01"
    ```

=== "HTTP"
    ``` http
    POST /tvshows HTTP/1.1
    Host: ntfy.sh
    Icon: https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png
    Tags: arrow_forward
    Title: Kodi: Resuming Playback

    The Wire, S01E01
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/tvshows', {
        method: 'POST',
        headers: {
            'Icon': 'https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png',
            'Title': 'Kodi: Resuming Playback',
            'Tags': 'arrow_forward'
        },
        body: "The Wire, S01E01"
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/tvshows", strings.NewReader("The Wire, S01E01"))
    req.Header.Set("Icon", "https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png")
    req.Header.Set("Tags", "arrow_forward")
    req.Header.Set("Title", "Kodi: Resuming Playback")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/tvshows"
      Headers = @{
        Title = "Kodi: Resuming Playback"
        Tags = "arrow_forward"
        Icon = "https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png"
      }
      Body = "The Wire, S01E01"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/tvshows",
        data="The Wire, S01E01",
        headers={
            "Title": "Kodi: Resuming Playback",
            "Tags": "arrow_forward",
            "Icon": "https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png"
        })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/tvshows', false, stream_context_create([
        'http' => [
        'method' => 'PUT',
        'header' =>
            "Content-Type: text/plain\r\n" . // Does not matter
            "Title: Kodi: Resuming Playback\r\n" .
            "Tags: arrow_forward\r\n" .
            "Icon: https://styles.redditmedia.com/t5_32uhe/styles/communityIcon_xnt6chtnr2j21.png",
        ],
        'content' => "The Wire, S01E01"
    ]));
    ```

Here's an example of how it will look on Android:

<figure markdown>
  ![file attachment](static/img/android-screenshot-icon.png){ width=500 }
  <figcaption>Custom icon from an external URL</figcaption>
</figure>

## Attachments
_Supported on:_ :material-android: :material-apple: :material-firefox:

You can **send images and other files to your phone** as attachments to a notification. The attachments are then downloaded
onto your phone (depending on size and setting automatically), and can be used from the Downloads folder.

There are two different ways to send attachments:

* sending [a local file](#attach-local-file) via PUT, e.g. from `~/Flowers/flower.jpg` or `ringtone.mp3`
* or by [passing an external URL](#attach-file-from-a-url) as an attachment, e.g. `https://f-droid.org/F-Droid.apk`

### Attach local file
To **send a file from your computer** as an attachment, you can send it as the PUT request body. If a message is greater
than the maximum message size (4,096 bytes) or consists of non UTF-8 characters, the ntfy server will automatically
detect the mime type and size, and send the message as an attachment file. To send smaller text-only messages or files
as attachments, you must pass a filename by passing the `X-Filename` header or query parameter (or any of its aliases
`Filename`, `File` or `f`).

By default, and how ntfy.sh is configured, the **max attachment size is 15 MB** (with 100 MB total per visitor).
Attachments **expire after 3 hours**, which typically is plenty of time for the user to download it, or for the Android app
to auto-download it. Please also check out the [other limits below](#limitations).

Here's an example showing how to upload an image:

=== "Command line (curl)"
    ```
    curl \
        -T flower.jpg \
        -H "Filename: flower.jpg" \
        ntfy.sh/flowers
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --file=flower.jpg \
        flowers
    ```

=== "HTTP"
    ``` http
    PUT /flowers HTTP/1.1
    Host: ntfy.sh
    Filename: flower.jpg
    Content-Type: 52312

    (binary JPEG data)
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/flowers', {
        method: 'PUT',
        body: document.getElementById("file").files[0],
        headers: { 'Filename': 'flower.jpg' }
    })
    ```

=== "Go"
    ``` go
    file, _ := os.Open("flower.jpg")
    req, _ := http.NewRequest("PUT", "https://ntfy.sh/flowers", file)
    req.Header.Set("Filename", "flower.jpg")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      Uri = "ntfy.sh/flowers"
      InFile = "flower.jpg"
      Headers = @{"Filename" = "flower.jpg"}
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.put("https://ntfy.sh/flowers",
        data=open("flower.jpg", 'rb'),
        headers={ "Filename": "flower.jpg" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/flowers', false, stream_context_create([
        'http' => [
            'method' => 'PUT',
            'header' =>
                "Content-Type: application/octet-stream\r\n" . // Does not matter
                "Filename: flower.jpg",
            'content' => file_get_contents('flower.jpg') // Dangerous for large files
        ]
    ]));
    ```

Here's what that looks like on Android:

<figure markdown>
  ![image attachment](static/img/android-screenshot-attachment-image.png){ width=500 }
  <figcaption>Image attachment sent from a local file</figcaption>
</figure>

### Attach file from a URL
Instead of sending a local file to your phone, you can use **an external URL** to specify where the attachment is hosted.
This could be a Dropbox link, a file from social media, or any other publicly available URL. Since the files are
externally hosted, the expiration or size limits from above do not apply here.

To attach an external file, simple pass the `X-Attach` header or query parameter (or any of its aliases `Attach` or `a`)
to specify the attachment URL. It can be any type of file.

ntfy will automatically try to derive the file name from the URL (e.g `https://example.com/flower.jpg` will yield a
filename `flower.jpg`). To override this filename, you may send the `X-Filename` header or query parameter (or any of its
aliases `Filename`, `File` or `f`).

Here's an example showing how to attach an APK file:

=== "Command line (curl)"
    ```
    curl \
        -X POST \
        -H "Attach: https://f-droid.org/F-Droid.apk" \
        ntfy.sh/mydownloads
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --attach="https://f-droid.org/F-Droid.apk" \
        mydownloads
    ```

=== "HTTP"
    ``` http
    POST /mydownloads HTTP/1.1
    Host: ntfy.sh
    Attach: https://f-droid.org/F-Droid.apk
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/mydownloads', {
        method: 'POST',
        headers: { 'Attach': 'https://f-droid.org/F-Droid.apk' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/mydownloads", file)
    req.Header.Set("Attach", "https://f-droid.org/F-Droid.apk")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/mydownloads"
      Headers = @{ Attach="https://f-droid.org/F-Droid.apk" }
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.put("https://ntfy.sh/mydownloads",
        headers={ "Attach": "https://f-droid.org/F-Droid.apk" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/mydownloads', false, stream_context_create([
        'http' => [
        'method' => 'PUT',
        'header' =>
            "Content-Type: text/plain\r\n" . // Does not matter
            "Attach: https://f-droid.org/F-Droid.apk",
        ]
    ]));
    ```

<figure markdown>
  ![file attachment](static/img/android-screenshot-attachment-file.png){ width=500 }
  <figcaption>File attachment sent from an external URL</figcaption>
</figure>

## Action buttons
_Supported on:_ :material-android: :material-apple: :material-firefox:

You can add action buttons to notifications to allow yourself to react to a notification directly. This is incredibly
useful and has countless applications.

You can control your home appliances (open/close garage door, change temperature on thermostat, ...), react to common
monitoring alerts (clear logs when disk is full, ...), and many other things. The sky is the limit.

As of today, the following actions are supported:

* [`view`](#open-websiteapp): Opens a website or app when the action button is tapped
* [`broadcast`](#send-android-broadcast): Sends an [Android broadcast](https://developer.android.com/guide/components/broadcasts) intent
  when the action button is tapped (only supported on Android)
* [`http`](#send-http-request): Sends HTTP POST/GET/PUT request when the action button is tapped
* [`copy`](#copy-to-clipboard): Copies a given value to the clipboard when the action button is tapped

Here's an example of what a notification with actions can look like:

<figure markdown>
  ![notification with actions](static/img/android-screenshot-notification-actions.png){ width=500 }
  <figcaption>Notification with two user actions</figcaption>
</figure>

### Defining actions
You can define **up to three user actions** in your notifications, using either of the following methods:

* In the [`X-Actions` header](#using-a-header), using a simple comma-separated format
* As a [JSON array](#using-a-json-array) in the `actions` key, when [publishing as JSON](#publish-as-json)

#### Using a header
To define actions using the `X-Actions` header (or any of its aliases: `Actions`, `Action`), use the following format:

=== "Header format (long)"
    ```
    action=<action1>, label=<label1>, paramN=... [; action=<action2>, label=<label2>, ...]
    ```

=== "Header format (short)"
    ```
    <action1>, <label1>, paramN=... [; <action2>, <label2>, ...]
    ```

Multiple actions are separated by a semicolon (`;`), and key/value pairs are separated by commas (`,`). Values may be
quoted with double quotes (`"`) or single quotes (`'`) if the value itself contains commas or semicolons.

Each action type has a short format where some key prefixes can be omitted:

* [`view`](#open-websiteapp): `view, <label>, <url>[, clear=true]`
* [`broadcast`](#send-android-broadcast):`broadcast, <label>[, extras.<param>=<value>][, intent=<intent>][, clear=true]`
* [`http`](#send-http-request): `http, <label>, <url>[, method=<method>][, headers.<header>=<value>][, body=<body>][, clear=true]`
* [`copy`](#copy-to-clipboard): `copy, <label>, <value>[, clear=true]`

As an example, here's how you can create the above notification using this format. Refer to the [`view` action](#open-websiteapp) and
[`http` action](#send-http-request) section for details on the specific actions:

=== "Command line (curl)"
    ```
    body='{"temperature": 65}'
    curl \
        -d "You left the house. Turn down the A/C?" \
        -H "Actions: view, Open portal, https://home.nest.com/, clear=true; \
                     http, Turn down, https://api.nest.com/, body='$body'" \
        ntfy.sh/myhome
    ```

=== "ntfy CLI"
    ```
    body='{"temperature": 65}'
    ntfy publish \
        --actions="view, Open portal, https://home.nest.com/, clear=true; \
                   http, Turn down, https://api.nest.com/, body='$body'" \
        myhome \
        "You left the house. Turn down the A/C?"
    ```

=== "HTTP"
    ``` http
    POST /myhome HTTP/1.1
    Host: ntfy.sh
    Actions: view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body='{"temperature": 65}'

    You left the house. Turn down the A/C?
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/myhome', {
        method: 'POST',
        body: 'You left the house. Turn down the A/C?',
        headers: {
            'Actions': 'view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body=\'{"temperature": 65}\''
        }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/myhome", strings.NewReader("You left the house. Turn down the A/C?"))
    req.Header.Set("Actions", "view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body='{\"temperature\": 65}'")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/myhome"
      Headers = @{
        Actions="view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body='{\"temperature\": 65}'"
      }
      Body = "You left the house. Turn down the A/C?"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/myhome",
        data="You left the house. Turn down the A/C?",
        headers={ "Actions": "view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body='{\"temperature\": 65}'" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/reddit_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Actions: view, Open portal, https://home.nest.com/, clear=true; http, Turn down, https://api.nest.com/, body='{\"temperature\": 65}'",
            'content' => 'You left the house. Turn down the A/C?'
        ]
    ]));
    ```

!!! info
    ntfy supports UTF-8 in HTTP headers, but [not every library or programming language does](https://www.jmix.io/blog/utf-8-in-http-headers/).
    If non-ASCII characters are causing issues for you in the title (i.e. you're seeing `?` symbols), you may also encode any header (including actions)
    as [RFC 2047](https://datatracker.ietf.org/doc/html/rfc2047#section-2), e.g. `=?UTF-8?B?8J+HqfCfh6o=?=` ([base64](https://en.wikipedia.org/wiki/Base64)),
    or `=?UTF-8?Q?=C3=84pfel?=` ([quoted-printable](https://en.wikipedia.org/wiki/Quoted-printable)).

#### Using a JSON array
Alternatively, the same actions can be defined as **JSON array**, if the notification is defined as part of the JSON body
(see [publish as JSON](#publish-as-json)):

=== "Command line (curl)"
    ```
    curl ntfy.sh \
      -d '{
        "topic": "myhome",
        "message": "You left the house. Turn down the A/C?",
        "actions": [
          {
            "action": "view",
            "label": "Open portal",
            "url": "https://home.nest.com/",
            "clear": true
          },
          {
            "action": "http",
            "label": "Turn down",
            "url": "https://api.nest.com/",
            "body": "{\"temperature\": 65}"
          }
        ]
      }'
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions '[
            {
                "action": "view",
                "label": "Open portal",
                "url": "https://home.nest.com/",
                "clear": true
            },
            {
                "action": "http",
                "label": "Turn down",
                "url": "https://api.nest.com/",
                "body": "{\"temperature\": 65}"
            }
        ]' \
        myhome \
        "You left the house. Turn down the A/C?"
    ```

=== "HTTP"
    ``` http
    POST / HTTP/1.1
    Host: ntfy.sh

    {
        "topic": "myhome",
        "message": "You left the house. Turn down the A/C?",
        "actions": [
          {
            "action": "view",
            "label": "Open portal",
            "url": "https://home.nest.com/",
            "clear": true
          },
          {
            "action": "http",
            "label": "Turn down",
            "url": "https://api.nest.com/",
            "body": "{\"temperature\": 65}"
          }
        ]
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh', {
        method: 'POST',
        body: JSON.stringify({
            topic: "myhome",
            message: "You left the house. Turn down the A/C?",
            actions: [
                {
                    action: "view",
                    label: "Open portal",
                    url: "https://home.nest.com/",
                    clear: true
                },
                {
                    action: "http",
                    label: "Turn down",
                    url: "https://api.nest.com/",
                    body: "{\"temperature\": 65}"
                }
            ]
        })
    })
    ```

=== "Go"
    ``` go
    // You should probably use json.Marshal() instead and make a proper struct,
    // but for the sake of the example, this is easier.

    body := `{
        "topic": "myhome",
        "message": "You left the house. Turn down the A/C?",
        "actions": [
          {
            "action": "view",
            "label": "Open portal",
            "url": "https://home.nest.com/",
            "clear": true
          },
          {
            "action": "http",
            "label": "Turn down",
            "url": "https://api.nest.com/",
            "body": "{\"temperature\": 65}"
          }
        ]
    }`
    req, _ := http.NewRequest("POST", "https://ntfy.sh/", strings.NewReader(body))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh"
      Body = ConvertTo-JSON @{
        Topic   = "myhome"
        Message = "You left the house. Turn down the A/C?"
        Actions = @(
          @{
            Action = "view"
            Label  = "Open portal"
            URL    = "https://home.nest.com/"
            Clear  = $true
          },
          @{
            Action = "http"
            Label  = "Turn down"
            URL    = "https://api.nest.com/"
            Body   = '{"temperature": 65}'
          }
        )
      }
      ContentType = "application/json"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/",
        data=json.dumps({
            "topic": "myhome",
            "message": "You left the house. Turn down the A/C?",
            "actions": [
                {
                    "action": "view",
                    "label": "Open portal",
                    "url": "https://home.nest.com/",
                    "clear": true
                },
                {
                    "action": "http",
                    "label": "Turn down",
                    "url": "https://api.nest.com/",
                    "body": "{\"temperature\": 65}"
                }
            ]
        })
    )
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => json_encode([
                "topic": "myhome",
                "message": "You left the house. Turn down the A/C?",
                "actions": [
                    [
                        "action": "view",
                        "label": "Open portal",
                        "url": "https://home.nest.com/",
                        "clear": true
                    ],
                    [
                        "action": "http",
                        "label": "Turn down",
                        "url": "https://api.nest.com/",
                        "headers": [
                            "Authorization": "Bearer ..."
                        ],
                        "body": "{\"temperature\": 65}"
                    ]
                ]
            ])
        ]
    ]));
    ```

The required/optional fields for each action depend on the type of the action itself. Please refer to
[`view` action](#open-websiteapp), [`broadcast` action](#send-android-broadcast), [`http` action](#send-http-request),
and [`copy` action](#copy-to-clipboard) for details.

### Open website/app
_Supported on:_ :material-android: :material-apple: :material-firefox:

The `view` action **opens a website or app when the action button is tapped**, e.g. a browser, a Google Maps location, or
even a deep link into Twitter or a show ntfy topic. How exactly the action is handled depends on how Android and your
desktop browser treat the links. Normally it'll just open a link in the browser.

Examples:

* `http://` or `https://` will open your browser (or an app if it registered for a URL)
* `mailto:` links will open your mail app, e.g. `mailto:phil@example.com`
* `geo:` links will open Google Maps, e.g. `geo:0,0?q=1600+Amphitheatre+Parkway,+Mountain+View,+CA`
* `ntfy://` links will open ntfy (see [ntfy:// links](subscribe/phone.md#ntfy-links)), e.g. `ntfy://ntfy.sh/stats`
* `twitter://` links will open Twitter, e.g. `twitter://user?screen_name=..`
* ...

Here's an example using the [`X-Actions` header](#using-a-header):

=== "Command line (curl)"
    ```
    curl \
        -d "Somebody retweeted your tweet." \
        -H "Actions: view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392" \
    ntfy.sh/myhome
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions="view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392" \
        myhome \
        "Somebody retweeted your tweet."
    ```

=== "HTTP"
    ``` http
    POST /myhome HTTP/1.1
    Host: ntfy.sh
    Actions: view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392

    Somebody retweeted your tweet.
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/myhome', {
        method: 'POST',
        body: 'Somebody retweeted your tweet.',
        headers: {
            'Actions': 'view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392'
        }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/myhome", strings.NewReader("Somebody retweeted your tweet."))
    req.Header.Set("Actions", "view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/myhome"
      Headers = @{
        Actions = "view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392"
      }
      Body = "Somebody retweeted your tweet."
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/myhome",
        data="Somebody retweeted your tweet.",
        headers={ "Actions": "view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/reddit_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Actions: view, Open Twitter, https://twitter.com/binwiederhier/status/1467633927951163392",
            'content' => 'Somebody retweeted your tweet.'
        ]
    ]));
    ```

And the same example using [JSON publishing](#publish-as-json):

=== "Command line (curl)"
    ```
    curl ntfy.sh \
      -d '{
        "topic": "myhome",
        "message": "Somebody retweeted your tweet.",
        "actions": [
          {
            "action": "view",
            "label": "Open Twitter",
            "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
          }
        ]
      }'
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions '[
            {
                "action": "view",
                "label": "Open Twitter",
                "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
            }
        ]' \
        myhome \
        "Somebody retweeted your tweet."
    ```

=== "HTTP"
    ``` http
    POST / HTTP/1.1
    Host: ntfy.sh

    {
        "topic": "myhome",
        "message": "Somebody retweeted your tweet.",
        "actions": [
          {
            "action": "view",
            "label": "Open Twitter",
            "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
          }
        ]
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh', {
        method: 'POST',
        body: JSON.stringify({
            topic: "myhome",
            message: "Somebody retweeted your tweet.",
            actions: [
                {
                    action: "view",
                    label: "Open Twitter",
                    url: "https://twitter.com/binwiederhier/status/1467633927951163392"
                }
            ]
        })
    })
    ```

=== "Go"
    ``` go
    // You should probably use json.Marshal() instead and make a proper struct,
    // but for the sake of the example, this is easier.

    body := `{
        "topic": "myhome",
        "message": "Somebody retweeted your tweet.",
        "actions": [
          {
            "action": "view",
            "label": "Open Twitter",
            "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
          }
        ]
    }`
    req, _ := http.NewRequest("POST", "https://ntfy.sh/", strings.NewReader(body))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh"
      Body = ConvertTo-JSON @{
        Topic = "myhome"
        Message = "Somebody retweeted your tweet."
        Actions = @(
          @{
            Action = "view"
            Label  = "Open Twitter"
            URL    = "https://twitter.com/binwiederhier/status/1467633927951163392"
          }
        )
      }
      ContentType = "application/json"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/",
        data=json.dumps({
            "topic": "myhome",
            "message": "Somebody retweeted your tweet.",
            "actions": [
                {
                    "action": "view",
                    "label": "Open Twitter",
                    "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
                }
            ]
        })
    )
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => json_encode([
                "topic": "myhome",
                "message": "Somebody retweeted your tweet.",
                "actions": [
                    [
                        "action": "view",
                        "label": "Open Twitter",
                        "url": "https://twitter.com/binwiederhier/status/1467633927951163392"
                    ]
                ]
            ])
        ]
    ]));
    ```

The short format for the `view` action is `view, <label>, <url>` (e.g. `view, Open Google, https://google.com`),
but you can always just use the `<key>=<value>` notation as well (e.g. `action=view, url=https://google.com, label=Open Google`).

The `view` action supports the following fields:

| Field    | Required | Type      | Default | Example               | Description                                      |
|----------|----------|-----------|---------|-----------------------|--------------------------------------------------|
| `action` | ✔️       | *string*  | -       | `view`                | Action type (**must be `view`**)                 |
| `label`  | ✔️       | *string*  | -       | `Turn on light`       | Label of the action button in the notification   |
| `url`    | ✔️       | *URL*     | -       | `https://example.com` | URL to open when action is tapped                |
| `clear`  | -️       | *boolean* | `false` | `true`                | Clear notification after action button is tapped |

### Send Android broadcast
_Supported on:_ :material-android:

The `broadcast` action **sends an [Android broadcast](https://developer.android.com/guide/components/broadcasts) intent
when the action button is tapped**. This allows integration into automation apps such as [MacroDroid](https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid)
or [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm), which basically means
you can do everything your phone is capable of. Examples include taking pictures, launching/killing apps, change device
settings, write/read files, etc.

By default, the intent action **`io.heckel.ntfy.USER_ACTION`** is broadcast, though this can be changed with the `intent` parameter (see below).
To send extras, use the `extras` parameter. Currently, **only string extras are supported**.

!!! info
    If you have no idea what this is, check out the [automation apps](subscribe/phone.md#automation-apps) section, which shows
    how to integrate Tasker and MacroDroid **with screenshots**. The action button integration is identical, except that
    you have to use **the intent action `io.heckel.ntfy.USER_ACTION`** instead.

Here's an example using the [`X-Actions` header](#using-a-header):

=== "Command line (curl)"
    ```
    curl \
        -d "Your wife requested you send a picture of yourself." \
        -H "Actions: broadcast, Take picture, extras.cmd=pic, extras.camera=front" \
    ntfy.sh/wifey
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions="broadcast, Take picture, extras.cmd=pic, extras.camera=front" \
        wifey \
        "Your wife requested you send a picture of yourself."
    ```

=== "HTTP"
    ``` http
    POST /wifey HTTP/1.1
    Host: ntfy.sh
    Actions: broadcast, Take picture, extras.cmd=pic, extras.camera=front

    Your wife requested you send a picture of yourself.
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/wifey', {
        method: 'POST',
        body: 'Your wife requested you send a picture of yourself.',
        headers: {
            'Actions': 'broadcast, Take picture, extras.cmd=pic, extras.camera=front'
        }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/wifey", strings.NewReader("Your wife requested you send a picture of yourself."))
    req.Header.Set("Actions", "broadcast, Take picture, extras.cmd=pic, extras.camera=front")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/wifey"
      Headers = @{
        Actions = "broadcast, Take picture, extras.cmd=pic, extras.camera=front"
      }
      Body = "Your wife requested you send a picture of yourself."
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/wifey",
        data="Your wife requested you send a picture of yourself.",
        headers={ "Actions": "broadcast, Take picture, extras.cmd=pic, extras.camera=front" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/wifey', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Actions: broadcast, Take picture, extras.cmd=pic, extras.camera=front",
            'content' => 'Your wife requested you send a picture of yourself.'
        ]
    ]));
    ```

And the same example using [JSON publishing](#publish-as-json):

=== "Command line (curl)"
    ```
    curl ntfy.sh \
      -d '{
        "topic": "wifey",
        "message": "Your wife requested you send a picture of yourself.",
        "actions": [
          {
            "action": "broadcast",
            "label": "Take picture",
            "extras": {
                "cmd": "pic",
                "camera": "front"
            }
          }
        ]
      }'
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions '[
            {
                "action": "broadcast",
                "label": "Take picture",
                "extras": {
                    "cmd": "pic",
                    "camera": "front"
                }
            }
        ]' \
        wifey \
        "Your wife requested you send a picture of yourself."
    ```

=== "HTTP"
    ``` http
    POST / HTTP/1.1
    Host: ntfy.sh

    {
        "topic": "wifey",
        "message": "Your wife requested you send a picture of yourself.",
        "actions": [
          {
            "action": "broadcast",
            "label": "Take picture",
            "extras": {
                "cmd": "pic",
                "camera": "front"
            }
          }
        ]
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh', {
        method: 'POST',
        body: JSON.stringify({
            topic: "wifey",
            message: "Your wife requested you send a picture of yourself.",
            actions: [
                {
                    "action": "broadcast",
                    "label": "Take picture",
                    "extras": {
                        "cmd": "pic",
                        "camera": "front"
                    }
                }
            ]
        })
    })
    ```

=== "Go"
    ``` go
    // You should probably use json.Marshal() instead and make a proper struct,
    // but for the sake of the example, this is easier.

    body := `{
        "topic": "wifey",
        "message": "Your wife requested you send a picture of yourself.",
        "actions": [
          {
            "action": "broadcast",
            "label": "Take picture",
            "extras": {
                "cmd": "pic",
                "camera": "front"
            }
          }
        ]
    }`
    req, _ := http.NewRequest("POST", "https://ntfy.sh/", strings.NewReader(body))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    # Powershell requires the 'Depth' argument to equal 3 here to expand 'Extras',
    # otherwise it will read System.Collections.Hashtable in the returned JSON
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh"
      Body = ConvertTo-Json -Depth 3 @{
        Topic = "wifey"
        Message = "Your wife requested you send a picture of yourself."
        Actions = @(
          @{
            Action = "broadcast"
            Label = "Take picture"
            Extras = @{
              CMD ="pic"
              Camera = "front"
            }
          }
        )
      }
      ContentType = "application/json"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/",
        data=json.dumps({
            "topic": "wifey",
            "message": "Your wife requested you send a picture of yourself.",
            "actions": [
                {
                    "action": "broadcast",
                    "label": "Take picture",
                    "extras": {
                        "cmd": "pic",
                        "camera": "front"
                    }
                }
            ]
        })
    )
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => json_encode([
                "topic": "wifey",
                "message": "Your wife requested you send a picture of yourself.",
                "actions": [
                    [
                    "action": "broadcast",
                    "label": "Take picture",
                    "extras": [
                        "cmd": "pic",
                        "camera": "front"
                    ]
                ]
            ])
        ]
    ]));
    ```

The short format for the `broadcast` action is `broadcast, <label>, <url>` (e.g. `broadcast, Take picture, extras.cmd=pic`),
but you can always just use the `<key>=<value>` notation as well (e.g. `action=broadcast, label=Take picture, extras.cmd=pic`).

The `broadcast` action supports the following fields:

| Field    | Required | Type             | Default                      | Example                 | Description                                                                                                                                                                            |
|----------|----------|------------------|------------------------------|-------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `action` | ✔️       | *string*         | -                            | `broadcast`             | Action type (**must be `broadcast`**)                                                                                                                                                  |
| `label`  | ✔️       | *string*         | -                            | `Turn on light`         | Label of the action button in the notification                                                                                                                                         |
| `intent` | -️       | *string*         | `io.heckel.ntfy.USER_ACTION` | `com.example.AN_INTENT` | Android intent name, **default is `io.heckel.ntfy.USER_ACTION`**                                                                                                                       |
| `extras` | -️       | *map of strings* | -                            | *see above*             | Android intent extras. Currently, only string extras are supported. When publishing as JSON, extras are passed as a map. When the simple format is used, use `extras.<param>=<value>`. |
| `clear`  | -️       | *boolean*        | `false`                      | `true`                  | Clear notification after action button is tapped                                                                                                                                       |

### Send HTTP request
_Supported on:_ :material-android: :material-apple: :material-firefox:

The `http` action **sends a HTTP request when the action button is tapped**. You can use this to trigger REST APIs
for whatever systems you have, e.g. opening the garage door, or turning on/off lights.

By default, this action sends a **POST request** (not GET!), though this can be changed with the `method` parameter.
The only required parameter is `url`. Headers can be passed along using the `headers` parameter.

Here's an example using the [`X-Actions` header](#using-a-header):

=== "Command line (curl)"
    ```
    curl \
        -d "Garage door has been open for 15 minutes. Close it?" \
        -H "Actions: http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}" \
        ntfy.sh/myhome
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions="http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}" \
        myhome \
        "Garage door has been open for 15 minutes. Close it?"
    ```

=== "HTTP"
    ``` http
    POST /myhome HTTP/1.1
    Host: ntfy.sh
    Actions: http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={"action": "close"}

    Garage door has been open for 15 minutes. Close it?
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/myhome', {
        method: 'POST',
        body: 'Garage door has been open for 15 minutes. Close it?',
        headers: {
            'Actions': 'http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}'
        }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/myhome", strings.NewReader("Garage door has been open for 15 minutes. Close it?"))
    req.Header.Set("Actions", "http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/myhome"
      Headers = @{
        Actions="http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}"
      }
      Body = "Garage door has been open for 15 minutes. Close it?"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/myhome",
        data="Garage door has been open for 15 minutes. Close it?",
        headers={ "Actions": "http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/reddit_alerts', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                'Actions: http, Close door, https://api.mygarage.lan/, method=PUT, headers.Authorization=Bearer zAzsx1sk.., body={\"action\": \"close\"}',
            'content' => 'Garage door has been open for 15 minutes. Close it?'
        ]
    ]));
    ```

And the same example using [JSON publishing](#publish-as-json):

=== "Command line (curl)"
    ```
    curl ntfy.sh \
      -d '{
        "topic": "myhome",
        "message": "Garage door has been open for 15 minutes. Close it?",
        "actions": [
          {
            "action": "http",
            "label": "Close door",
            "url": "https://api.mygarage.lan/",
            "method": "PUT",
            "headers": {
                "Authorization": "Bearer zAzsx1sk.."
            },
            "body": "{\"action\": \"close\"}"
          }
        ]
      }'
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions '[
            {
              "action": "http",
              "label": "Close door",
              "url": "https://api.mygarage.lan/",
              "method": "PUT",
              "headers": {
                "Authorization": "Bearer zAzsx1sk.."
              },
              "body": "{\"action\": \"close\"}"
            }
        ]' \
        myhome \
        "Garage door has been open for 15 minutes. Close it?"
    ```

=== "HTTP"
    ``` http
    POST / HTTP/1.1
    Host: ntfy.sh

    {
        "topic": "myhome",
        "message": "Garage door has been open for 15 minutes. Close it?",
        "actions": [
          {
            "action": "http",
            "label": "Close door",
            "url": "https://api.mygarage.lan/",
            "method": "PUT",
            "headers": {
              "Authorization": "Bearer zAzsx1sk.."
            },
            "body": "{\"action\": \"close\"}"
          }
        ]
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh', {
        method: 'POST',
        body: JSON.stringify({
            topic: "myhome",
            message: "Garage door has been open for 15 minutes. Close it?",
            actions: [
              {
                "action": "http",
                "label": "Close door",
                "url": "https://api.mygarage.lan/",
                "method": "PUT",
                "headers": {
                  "Authorization": "Bearer zAzsx1sk.."
                },
                "body": "{\"action\": \"close\"}"
              }
            ]
        })
    })
    ```

=== "Go"
    ``` go
    // You should probably use json.Marshal() instead and make a proper struct,
    // but for the sake of the example, this is easier.

    body := `{
        "topic": "myhome",
        "message": "Garage door has been open for 15 minutes. Close it?",
        "actions": [
          {
            "action": "http",
            "label": "Close door",
            "method": "PUT",
            "url": "https://api.mygarage.lan/",
            "headers": {
              "Authorization": "Bearer zAzsx1sk.."
            },
            "body": "{\"action\": \"close\"}"
          }
        ]
    }`
    req, _ := http.NewRequest("POST", "https://ntfy.sh/", strings.NewReader(body))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    # Powershell requires the 'Depth' argument to equal 3 here to expand 'headers',
    # otherwise it will read System.Collections.Hashtable in the returned JSON

    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh"
      Body = ConvertTo-Json -Depth 3 @{
        Topic   = "myhome"
        Message = "Garage door has been open for 15 minutes. Close it?"
        Actions = @(
          @{
            Action  = "http"
            Label   = "Close door"
            URL     = "https://api.mygarage.lan/"
            Method  = "PUT"
            Headers = @{
              Authorization = "Bearer zAzsx1sk.."
            }
            Body    = ConvertTo-JSON @{Action = "close"}
          }
        )
      }
      ContentType = "application/json"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/",
        data=json.dumps({
            "topic": "myhome",
            "message": "Garage door has been open for 15 minutes. Close it?",
            "actions": [
                {
                  "action": "http",
                  "label": "Close door",
                  "url": "https://api.mygarage.lan/",
                  "method": "PUT",
                  "headers": {
                    "Authorization": "Bearer zAzsx1sk.."
                  },
                  "body": "{\"action\": \"close\"}"
                }
            ]
        })
    )
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => json_encode([
                "topic": "myhome",
                "message": "Garage door has been open for 15 minutes. Close it?",
                "actions": [
                    [
                        "action": "http",
                        "label": "Close door",
                        "url": "https://api.mygarage.lan/",
                        "method": "PUT",
                        "headers": [
                            "Authorization": "Bearer zAzsx1sk.."
                         ],
                        "body": "{\"action\": \"close\"}"
                    ]
                ]
            ])
        ]
    ]));
    ```

The short format for the `http` action is `http, <label>, <url>` (e.g. `http, Close door, https://api.mygarage.lan/close`),
but you can always just use the `<key>=<value>` notation as well (e.g. `action=http, label=Close door, url=https://api.mygarage.lan/close`).

The `http` action supports the following fields:

| Field     | Required | Type               | Default   | Example                   | Description                                                                                                                                             |
|-----------|----------|--------------------|-----------|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| `action`  | ✔️       | *string*           | -         | `http`                    | Action type (**must be `http`**)                                                                                                                        |
| `label`   | ✔️       | *string*           | -         | `Open garage door`        | Label of the action button in the notification                                                                                                          |
| `url`     | ✔️       | *string*           | -         | `https://ntfy.sh/mytopic` | URL to which the HTTP request will be sent                                                                                                              |
| `method`  | -️       | *GET/POST/PUT/...* | `POST` ⚠️ | `GET`                     | HTTP method to use for request, **default is POST** ⚠️                                                                                                  |
| `headers` | -️       | *map of strings*   | -         | *see above*               | HTTP headers to pass in request. When publishing as JSON, headers are passed as a map. When the simple format is used, use `headers.<header1>=<value>`. |
| `body`    | -️       | *string*           | *empty*   | `some body, somebody?`    | HTTP body                                                                                                                                               |
| `clear`   | -️       | *boolean*          | `false`   | `true`                    | Clear notification after HTTP request succeeds. If the request fails, the notification is not cleared.                                                  |

### Copy to clipboard
_Supported on:_ :material-android: :material-firefox:

The `copy` action **copies a given value to the clipboard when the action button is tapped**. This is useful for
one-time passcodes, tokens, or any other value you want to quickly copy without opening the full notification.

!!! info
    The copy action button is only shown in the web app and Android app notification list, **not** in browser desktop
    notifications. This is because browsers do not allow clipboard access from notification actions without direct
    user interaction with the page.

Here's an example using the [`X-Actions` header](#using-a-header):

=== "Command line (curl)"
    ```
    curl \
        -d "Your one-time passcode is 123456" \
        -H "Actions: copy, Copy code, 123456" \
        ntfy.sh/myhome
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions="copy, Copy code, 123456" \
        myhome \
        "Your one-time passcode is 123456"
    ```

=== "HTTP"
    ``` http
    POST /myhome HTTP/1.1
    Host: ntfy.sh
    Actions: copy, Copy code, 123456

    Your one-time passcode is 123456
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/myhome', {
        method: 'POST',
        body: 'Your one-time passcode is 123456',
        headers: {
            'Actions': 'copy, Copy code, 123456'
        }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/myhome", strings.NewReader("Your one-time passcode is 123456"))
    req.Header.Set("Actions", "copy, Copy code, 123456")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/myhome"
      Headers = @{
        Actions = "copy, Copy code, 123456"
      }
      Body = "Your one-time passcode is 123456"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/myhome",
        data="Your one-time passcode is 123456",
        headers={ "Actions": "copy, Copy code, 123456" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/myhome', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "Actions: copy, Copy code, 123456",
            'content' => 'Your one-time passcode is 123456'
        ]
    ]));
    ```

And the same example using [JSON publishing](#publish-as-json):

=== "Command line (curl)"
    ```
    curl ntfy.sh \
      -d '{
        "topic": "myhome",
        "message": "Your one-time passcode is 123456",
        "actions": [
          {
            "action": "copy",
            "label": "Copy code",
            "value": "123456"
          }
        ]
      }'
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --actions '[
            {
                "action": "copy",
                "label": "Copy code",
                "value": "123456"
            }
        ]' \
        myhome \
        "Your one-time passcode is 123456"
    ```

=== "HTTP"
    ``` http
    POST / HTTP/1.1
    Host: ntfy.sh

    {
        "topic": "myhome",
        "message": "Your one-time passcode is 123456",
        "actions": [
          {
            "action": "copy",
            "label": "Copy code",
            "value": "123456"
          }
        ]
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh', {
        method: 'POST',
        body: JSON.stringify({
            topic: "myhome",
            message: "Your one-time passcode is 123456",
            actions: [
                {
                    action: "copy",
                    label: "Copy code",
                    value: "123456"
                }
            ]
        })
    })
    ```

=== "Go"
    ``` go
    // You should probably use json.Marshal() instead and make a proper struct,
    // but for the sake of the example, this is easier.

    body := `{
        "topic": "myhome",
        "message": "Your one-time passcode is 123456",
        "actions": [
          {
            "action": "copy",
            "label": "Copy code",
            "value": "123456"
          }
        ]
    }`
    req, _ := http.NewRequest("POST", "https://ntfy.sh/", strings.NewReader(body))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh"
      Body = ConvertTo-JSON @{
        Topic = "myhome"
        Message = "Your one-time passcode is 123456"
        Actions = @(
          @{
            Action = "copy"
            Label  = "Copy code"
            Value  = "123456"
          }
        )
      }
      ContentType = "application/json"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/",
        data=json.dumps({
            "topic": "myhome",
            "message": "Your one-time passcode is 123456",
            "actions": [
                {
                    "action": "copy",
                    "label": "Copy code",
                    "value": "123456"
                }
            ]
        })
    )
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => json_encode([
                "topic": "myhome",
                "message": "Your one-time passcode is 123456",
                "actions": [
                    [
                        "action": "copy",
                        "label": "Copy code",
                        "value": "123456"
                    ]
                ]
            ])
        ]
    ]));
    ```

The short format for the `copy` action is `copy, <label>, <value>` (e.g. `copy, Copy code, 123456`),
but you can always just use the `<key>=<value>` notation as well (e.g. `action=copy, label=Copy code, value=123456`).

The `copy` action supports the following fields:

| Field    | Required | Type      | Default | Example         | Description                                      |
|----------|----------|-----------|---------|-----------------|--------------------------------------------------|
| `action` | ✔️       | *string*  | -       | `copy`          | Action type (**must be `copy`**)                 |
| `label`  | ✔️       | *string*  | -       | `Copy code`     | Label of the action button in the notification   |
| `value`  | ✔️       | *string*  | -       | `123456`        | Value to copy to the clipboard                   |
| `clear`  | -️       | *boolean* | `false` | `true`          | Clear notification after action button is tapped |

## Scheduled delivery
_Supported on:_ :material-android: :material-apple: :material-firefox:

You can delay the delivery of messages and let ntfy send them at a later date. This can be used to send yourself
reminders or even to execute commands at a later date (if your subscriber acts on messages).

Usage is pretty straight forward. You can set the delivery time using the `X-Delay` header (or any of its aliases: `Delay`,
`X-At`, `At`, `X-In` or `In`), either by specifying a Unix timestamp (e.g. `1639194738`), an RFC3339/ISO-8601 absolute
 timestamp (e.g. `2026-09-02T10:00:00Z`), a duration (e.g. `30m`, `3h`, `2 days`), or a natural language time string
(e.g. `10am`, `8:30pm`, `tomorrow, 3pm`, `Tuesday, 7am`, [and more](https://github.com/olebedev/when)).

To interpret a natural language time in a specific timezone, set the `X-Timezone` header
(alias: `Timezone`), the `timezone` query parameter, or the `timezone` JSON field to an
IANA timezone name such as `Asia/Tokyo` or `America/New_York`:

```
curl -H "At: tomorrow, 10am" -H "Timezone: Asia/Tokyo" -d "Good morning" ntfy.sh/hello
```

Without a timezone, the server's local timezone is used as before. The web app sends your
browser's timezone automatically when scheduling a message. Relative durations such as
`1h` and Unix timestamps still refer to the same instant regardless of timezone. Invalid
timezone names return HTTP 400 when a delay is supplied; without a delay, the timezone is ignored.

As of today, the minimum delay you can set is **10 seconds** and the maximum delay is **3 days**. This can be configured
with the `message-delay-limit` option.

For the purposes of [message caching](config.md#message-cache), scheduled messages are kept in the cache until 12 hours
after they were delivered (or whatever the server-side cache duration is set to). For instance, if a message is scheduled
to be delivered in 3 days, it'll remain in the cache for 3 days and 12 hours. Also note that naturally,
[turning off server-side caching](#message-caching) is not possible in combination with this feature.

=== "Command line (curl)"
    ```
    curl -H "At: tomorrow, 10am" -d "Good morning" ntfy.sh/hello
    curl -H "In: 30min" -d "It's 30 minutes later now" ntfy.sh/reminder
    curl -H "Delay: 2026-09-02T10:00:00Z" -d "RFC3339 timestamps are awesome" ntfy.sh/itsarfc3339system
    curl -H "Delay: 1639194738" -d "Unix timestamps are awesome" ntfy.sh/itsaunixsystem
    ```

=== "ntfy CLI"
    ```
    ntfy publish \
        --at="tomorrow, 10am" \
        hello "Good morning"
    ```

=== "HTTP"
    ``` http
    POST /hello HTTP/1.1
    Host: ntfy.sh
    At: tomorrow, 10am

    Good morning
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.sh/hello', {
        method: 'POST',
        body: 'Good morning',
        headers: { 'At': 'tomorrow, 10am' }
    })
    ```

=== "Go"
    ``` go
    req, _ := http.NewRequest("POST", "https://ntfy.sh/hello", strings.NewReader("Good morning"))
    req.Header.Set("At", "tomorrow, 10am")
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      URI = "https://ntfy.sh/hello"
      Headers = @{
        At = "tomorrow, 10am"
      }
      Body = "Good morning"
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.sh/hello",
        data="Good morning",
        headers={ "At": "tomorrow, 10am" })
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.sh/backups', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' =>
                "Content-Type: text/plain\r\n" .
                "At: tomorrow, 10am",
            'content' => 'Good morning'
        ]
    ]));
    ```

Here are a few examples (assuming today's date is **12/10/2021, 9am, Eastern Time Zone**):

<table class="remove-md-box"><tr>
<td>
    <table><thead><tr><th><code>Delay/At/In</code> header</th><th>Message will be delivered at</th><th>Explanation</th></tr></thead><tbody>
    <tr><td><code>30m</code></td><td>12/10/2021, 9:<b>30</b>am</td><td>30 minutes from now</td></tr>
    <tr><td><code>2 hours</code></td><td>12/10/2021, <b>11:30</b>am</td><td>2 hours from now</td></tr>
    <tr><td><code>1 day</code></td><td>12/<b>11</b>/2021, 9am</td><td>24 hours from now</td></tr>
    <tr><td><code>10am</code></td><td>12/10/2021, <b>10am</b></td><td>Today at 10am (same day, because it's only 9am)</td></tr>
    <tr><td><code>8am</code></td><td>12/<b>11</b>/2021, <b>8am</b></td><td>Tomorrow at 8am (because it's 9am already)</td></tr>
    <tr><td><code>2026-12-10T11:00:00-05:00</code></td><td>12/10/2026, <b>11am</b> (EST)</td><td>Absolute RFC3339 timestamp with timezone offset</td></tr>
    <tr><td><code>1639152000</code></td><td>12/10/2021, 11am (EST)</td><td> Today at 11am (EST)</td></tr>
    </tbody></table>
</td>
</tr></table>

### Updating scheduled notifications

You can update or replace a scheduled message before it is delivered by publishing a new message with the same
[sequence ID](#updating-deleting-notifications). When you do this, the **original scheduled message is deleted**
from the server and replaced with the new one. This is different from [updating notifications](#updating-notifications)
after delivery, where both messages are kept in the cache.

This is particularly useful for implementing a **watchdog that triggers when your script stops sending heartbeat messages**.
This mechanism is also called a [dead man's switch](https://en.wikipedia.org/wiki/Dead_man%27s_switch).

For example, you could schedule a message to be delivered in 5 minutes, but continuously update it every minute to push
the delivery time further into the future. If your script or system stops running, the message will eventually be delivered as an alert.

Here's an example of a dead man's switch that sends an alert if the script stops running for more than 5 minutes:

=== "Command line (curl)"
    ```bash
    # Dead man's switch: keeps pushing a scheduled message into the future
    # If this script stops, the alert will be delivered after 5 minutes
    while true; do
        curl -H "In: 5m" -d "Warning: Server heartbeat stopped!" \
            ntfy.sh/mytopic/heartbeat-check
        sleep 60  # Update every minute
    done
    ```

=== "ntfy CLI"
    ```bash
    # Dead man's switch: keeps pushing a scheduled message into the future
    # If this script stops, the alert will be delivered after 5 minutes
    while true; do
        ntfy publish \
            --in="5m" \
            --sequence-id="heartbeat-check" \
            mytopic "Warning: Server heartbeat stopped!"
        sleep 60  # Update every minute
    done
    ```

=== "HTTP"
    ``` http
    POST /mytopic/heartbeat-check HTTP/1.1
    Host: ntfy.sh
    In: 5m

    Warning: Server heartbeat stopped!
    ```

=== "JavaScript"
    ``` javascript
    // Dead man's switch: keeps pushing a scheduled message into the future
    // If this script stops, the alert will be delivered after 5 minutes
    setInterval(() => {
        fetch('https://ntfy.sh/mytopic/heartbeat-check', {
            method: 'POST',
            body: 'Warning: Server heartbeat stopped!',
            headers: { 'In': '5m' }
        })
    }, 60000) // Update every minute
    ```

=== "Go"
    ``` go
    // Dead man's switch: keeps pushing a scheduled message into the future
    // If this script stops, the alert will be delivered after 5 minutes
    for {
        req, _ := http.NewRequest("POST", "https://ntfy.sh/mytopic/heartbeat-check",
            strings.NewReader("Warning: Server heartbeat stopped!"))
        req.Header.Set("In", "5m")
        http.DefaultClient.Do(req)
        time.Sleep(60 * time.Second) // Update every minute
    }
    ```

=== "PowerShell"
    ``` powershell
    # Dead man's switch: keeps pushing a scheduled message into the future
    # If this script stops, the alert will be delivered after 5 minutes
    while ($true) {
        $Request = @{
            Method = "POST"
            URI = "https://ntfy.sh/mytopic/heartbeat-check"
            Headers = @{ In = "5m" }
            Body = "Warning: Server heartbeat stopped!"
        }
        Invoke-RestMethod @Request
        Start-Sleep -Seconds 60  # Update every minute
    }
    ```

=== "Python"
    ``` python
    import requests
    import time

    # Dead man's switch: keeps pushing a scheduled message into the future
    # If this script stops, the alert will be delivered after 5 minutes
    while True:
        requests.post(
            "https://ntfy.sh/mytopic/heartbeat-check",
            data="Warning: Server heartbeat stopped!",
            headers={"In": "5m"}
        )
        time.sleep(60) # Update every minute
    ```

=== "PHP"
    ``` php-inline
    // Dead man's switch: keeps pushing a scheduled message into the future
    // If this script stops, the alert will be delivered after 5 minutes
    while (true) {
        file_get_contents('https://ntfy.sh/mytopic/heartbeat-check', false, stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: text/plain\r\nIn: 5m",
                'content' => 'Warning: Server heartbeat stopped!'
            ]
        ]));
        sleep(60); // Update every minute
    }
    ```

### Canceling scheduled notifications

You can cancel a scheduled message before it is delivered by sending a DELETE request to the
`/<topic>/<sequence_id>` endpoint, just like [deleting notifications](#deleting-notifications). Alternatively, you can send a `GET`
request to `/<topic>/<sequence_id>/delete`. This will remove the scheduled message from the server so it will never be delivered,
and emit a `message_delete` event to any subscribers.

=== "Command line (curl)"
    ```bash
    # Schedule a reminder for 2 hours from now
    curl -H "In: 2h" -d "Take a break!" ntfy.sh/mytopic/break-reminder

    # Changed your mind? Cancel the scheduled message via DELETE
    curl -X DELETE ntfy.sh/mytopic/break-reminder

    # Or cancel it via GET
    curl ntfy.sh/mytopic/break-reminder/delete
    ```

=== "ntfy CLI"
    ```bash
    # Schedule a reminder for 2 hours from now
    ntfy publish --in="2h" mytopic/break-reminder "Take a break!"

    # Changed your mind? Cancel the scheduled message
    # (ntfy CLI does not support DELETE, use curl instead)
    curl -X DELETE ntfy.sh/mytopic/break-reminder
    ```

=== "HTTP"
    ``` http
    DELETE /mytopic/break-reminder HTTP/1.1
    Host: ntfy.sh
    ```

=== "JavaScript"
    ``` javascript
    // Schedule a reminder for 2 hours from now
    await fetch('https://ntfy.sh/mytopic/break-reminder', {
        method: 'POST',
        body: 'Take a break!',
        headers: { 'In': '2h' }
    });

    // Changed your mind? Cancel the scheduled message
    await fetch('https://ntfy.sh/mytopic/break-reminder', {
        method: 'DELETE'
    });
    ```

=== "Go"
    ``` go
    // Schedule a reminder for 2 hours from now
    req, _ := http.NewRequest("POST", "https://ntfy.sh/mytopic/break-reminder",
        strings.NewReader("Take a break!"))
    req.Header.Set("In", "2h")
    http.DefaultClient.Do(req)

    // Changed your mind? Cancel the scheduled message
    req, _ = http.NewRequest("DELETE", "https://ntfy.sh/mytopic/break-reminder", nil)
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    # Schedule a reminder for 2 hours from now
    $Request = @{
        Method = "POST"
        URI = "https://ntfy.sh/mytopic/break-reminder"
        Headers = @{ In = "2h" }
        Body = "Take a break!"
    }
    Invoke-RestMethod @Request

    # Changed your mind? Cancel the scheduled message
    Invoke-RestMethod -Method DELETE -Uri "https://ntfy.sh/mytopic/break-reminder"
    ```

=== "Python"
    ``` python
    import requests

    # Schedule a reminder for 2 hours from now
    requests.post(
        "https://ntfy.sh/mytopic/break-reminder",
        data="Take a break!",
        headers={"In": "2h"}
    )

    # Changed your mind? Cancel the scheduled message
    requests.delete("https://ntfy.sh/mytopic/break-reminder")
    ```

=== "PHP"
    ``` php-inline
    // Schedule a reminder for 2 hours from now
    file_get_contents('https://ntfy.sh/mytopic/break-reminder', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: text/plain\r\nIn: 2h",
            'content' => 'Take a break!'
        ]
    ]));

    // Changed your mind? Cancel the scheduled message
    file_get_contents('https://ntfy.sh/mytopic/break-reminder', false, stream_context_create([
        'http' => ['method' => 'DELETE']
    ]));
    ```

## Message templating
_Supported on:_ :material-android: :material-apple: :material-firefox:

Templating lets you **format a JSON message body into human-friendly message and title text** using
[Go templates](https://pkg.go.dev/text/template) (see tutorials [here](https://blog.gopheracademy.com/advent-2017/using-go-templates/),
[here](https://www.digitalocean.com/community/tutorials/how-to-use-templates-in-go), and
[here](https://developer.hashicorp.com/nomad/tutorials/templates/go-template-syntax)). This is specifically useful when
**combined with webhooks** from services such as [GitHub](https://docs.github.com/en/webhooks/about-webhooks),
[Grafana](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/),
[Alertmanager](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config), or other services that emit JSON webhooks.

Instead of using a separate bridge program to parse the webhook body into the format ntfy expects, you can include a templated
message and/or a templated title which will be populated based on the fields of the webhook body (so long as the webhook body
is valid JSON).

You can enable templating by setting the `X-Template` header (or its aliases `Template` or `tpl`, or the query parameter `?template=...`):

* **Pre-defined template files**: Setting the `X-Template` header or query parameter to a pre-defined template name (one of `github`,
  `grafana`, or `alertmanager`, such as `?template=github`) will use the built-in template with that name.
  See [pre-defined templates](#pre-defined-templates) for more details.
* **Custom template files**: Setting the `X-Template` header or query parameter to a custom template name (e.g. `?template=myapp`)
  will use a custom template file from the template directory (defaults to `/etc/ntfy/templates`, can be overridden with `template-dir`).
  See [custom templates](#custom-templates) for more details.
* **Inline templating**: Setting the `X-Template` header or query parameter to `yes` or `1` (e.g. `?template=yes`)
  will enable inline templating, which means that the `message`, `title`, and/or `priority` will be parsed as a Go template.
  See [inline templating](#inline-templating) for more details.

To learn the basics of Go's templating language, please see [template syntax](#template-syntax).

### Pre-defined templates

When `X-Template: <name>` (aliases: `Template: <name>`, `Tpl: <name>`) or `?template=<name>` is set, ntfy will transform the
message and/or title based on one of the built-in pre-defined templates.

The following **pre-defined templates** are available:

* `github`: Formats a subset of [GitHub webhook](https://docs.github.com/en/webhooks/about-webhooks) payloads (PRs, issues, new star, new watcher, new comment). See [github.yml](https://github.com/binwiederhier/ntfy/blob/main/server/templates/github.yml).
* `grafana`: Formats [Grafana webhook](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/) payloads (firing/resolved alerts). See [grafana.yml](https://github.com/binwiederhier/ntfy/blob/main/server/templates/grafana.yml).
* `alertmanager`: Formats [Alertmanager webhook](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config) payloads (firing/resolved alerts). See [alertmanager.yml](https://github.com/binwiederhier/ntfy/blob/main/server/templates/alertmanager.yml).

To override the pre-defined templates, you can place a file with the same name in the template directory (defaults to `/etc/ntfy/templates`,
can be overridden with `template-dir`). See [custom templates](#custom-templates) for more details.

Here's an example of how to use the **pre-defined `github` template**:

First, configure the webhook in GitHub to send a webhook to your ntfy topic, e.g. `https://ntfy.sh/mytopic?template=github`.
<figure markdown>
  ![GitHub webhook config](static/img/screenshot-github-webhook-config.png){ width=600 }
  <figcaption>GitHub webhook configuration</figcaption>
</figure>

After that, when GitHub publishes a JSON webhook to the topic, ntfy will transform it according to the template rules
and you'll receive notifications in the ntfy app. Here's an example for when somebody stars your repository:

<figure markdown>
  ![pre-defined template](static/img/android-screenshot-template-predefined.png){ width=500 }
  <figcaption>Receiving a webhook, formatted using the pre-defined "github" template</figcaption>
</figure>

### Custom templates

To define **your own custom templates**, place a template file in the template directory (defaults to `/etc/ntfy/templates`, can be overridden with `template-dir`)
and set the `X-Template` header or query parameter to the name of the template file (without the `.yml` extension).

For example, if you have a template file `/etc/ntfy/templates/myapp.yml`, you can set the header `X-Template: myapp` or
the query parameter `?template=myapp` to use it.

Template files must have the `.yml` (not: `.yaml`!) extension and must be formatted as YAML. They may contain `title`, `message`, and `priority` keys,
which are interpreted as Go templates.

Here's an **example custom template**:

=== "Custom template (/etc/ntfy/templates/myapp.yml)"
    ```yaml
    title: |
      {{- if eq .status "firing" }}
        {{- if gt .percent 90.0 }}🚨 Critical alert
        {{- else }}⚠️ Alert{{- end }}
      {{- else if eq .status "resolved" }}
      ✅ Alert resolved
      {{- end }}
    message: |
      Status: {{ .status }}
      Type: {{ .type | upper }} ({{ .percent }}%)
      Server: {{ .server }}
    priority: |
      {{ if gt .percent 90.0 }}5
      {{ else if gt .percent 75.0 }}4
      {{ else }}3
      {{ end }}
    ```

Once you have the template file in place, you can send the payload to your topic using the `X-Template`
header or query parameter:

=== "Command line (curl)"
    ```
    echo '{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}' | \
      curl -sT- "https://ntfy.example.com/mytopic?template=myapp"
    ```

=== "ntfy CLI"
    ```
    echo '{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}' | \
      ntfy publish --template=myapp https://ntfy.example.com/mytopic
    ```

=== "HTTP"
    ``` http
    POST /mytopic?template=myapp HTTP/1.1
    Host: ntfy.example.com

    {
      "status": "firing",
      "type": "cpu",
      "server": "ntfy.sh",
      "percent": 99
    }
    ```

=== "JavaScript"
    ``` javascript
    fetch('https://ntfy.example.com/mytopic?template=myapp', {
        method: 'POST',
        body: '{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}'
    })
    ```

=== "Go"
    ``` go
    payload := `{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}`
    req, _ := http.NewRequest("POST", "https://ntfy.example.com/mytopic?template=myapp", strings.NewReader(payload))
    http.DefaultClient.Do(req)
    ```

=== "PowerShell"
    ``` powershell
    $Request = @{
      Method = "POST"
      Uri = "https://ntfy.example.com/mytopic?template=myapp"
      Body = '{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}'
    }
    Invoke-RestMethod @Request
    ```

=== "Python"
    ``` python
    requests.post("https://ntfy.example.com/mytopic?template=myapp",
      json={"status":"firing","type":"cpu","server":"ntfy.sh","percent":99})
    ```

=== "PHP"
    ``` php-inline
    file_get_contents('https://ntfy.example.com/mytopic?template=myapp', false, stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json",
            'content' => '{"status":"firing","type":"cpu","server":"ntfy.sh","percent":99}'
        ]
    ]));
    ```

Which will result in a notification that looks like this:

<figure markdown>
  ![notification from custom JSON webhook template](static/img/android-screenshot-template-custom.png){ width=500 }
  <figcaption>JSON webhook, transformed using a custom template</figcaption>
</figure>

### Inline templating

When `X-Template: yes` (aliases: `Template: yes`, `Tpl: yes`) or `?template=yes` is set, you can use Go templates in the `message`, `title`, and `priority` fields of your
webhook payload.

Inline templates are most useful for templated one-off messages, or if you do not control the ntfy server (e.g., if you're using ntfy.sh).
Consider using [pre-defined templates](#pre-defined-templates) or [custom templates](#custom-templates) instead,
if you control the ntfy server, as templates are much easier to maintain.

Here's an **example for a Grafana alert**:

<figure markdown>
  ![notification with actions](static/img/android-screenshot-template.jpg){ width=500 }
  <figcaption>Grafana webhook, formatted using templates</figcaption>
</figure>

This was sent using the following templates and payloads

=== "Message template"
    ```
    {{range .alerts}}
      {{.annotations.summary}}

      Values:
      {{range $k,$v := .values}}
        - {{$k}}={{$v}}
      {{end}}
    {{end}}
    ```

=== "Title template"
    ```
    {{.title}}
    ```

=== "Encoded webhook URL"
    ```
    # Additional URL encoding (see https://www.urlencoder.org/) is necessary for Grafana,
    # and may be required for other tools too

    https://ntfy.sh/mytopic?tpl=1&t=%7B%7B.title%7D%7D&m=%7B%7Brange%20.alerts%7D%7D%7B%7B.annotations.summary%7D%7D%5Cn%5CnValues%3A%5Cn%7B%7Brange%20%24k%2C%24v%20%3A%3D%20.values%7D%7D-%20%7B%7B%24k%7D%7D%3D%7B%7B%24v%7D%7D%5Cn%7B%7Bend%7D%7D%7B%7Bend%7D%7D
    ```

=== "Grafana-sent payload"
    ```
    {"receiver":"ntfy\\.example\\.com/alerts","status":"resolved","alerts":[{"status":"resolved","labels":{"alertname":"Load avg 15m too high","grafana_folder":"Node alerts","instance":"10.108.0.2:9100","job":"node-exporter"},"annotations":{"summary":"15m load average too high"},"startsAt":"2024-03-15T02:28:00Z","endsAt":