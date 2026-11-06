# dsh-question-landscape

Layout and reply affordances for the Web `ask_user_question` composer.

While a question card is pending, the ordinary conversation input bar is hidden
by the composer chain (the card is elected and the fallback is `display: none`,
though still mounted). The card also owns the whole composer floor.

This plugin adds presentation only:

- **Landscape** (a horizontal device, or a short desktop window): the card docks
  to a right rail (`min(46vw, 560px)`) that fills the conversation body's height,
  and the ordinary composer returns to the bottom-left. The `回复` button is
  hidden there because the composer is already on screen.
- **Portrait**: one collapse, and it always keeps the composer. The `回复`
  button beside `跳过` collapses the card, reveals the composer and focuses it.
  The card's own header chevron collapses to the same reply layout (without
  stealing focus). Scrolling the conversation behind the card (touch or wheel)
  also collapses it; scrolling inside the card's own option list does not.
  Expanding the card from its strip clears the reply layout again.
- What the revealed composer sends is a normal message/steering that the host
  queues; it is not the answer, which still goes through the card.
- While a question is pending and the composer holds text, the ordinary send
  button doubles as **interrupt and send**: it cancels the turn through the
  session-scoped `conversation` service, waits for the session to leave
  `running`, then presses the same button again to deliver the draft as the
  next turn. If the cancel path is unavailable it falls back to the ordinary
  send (which queues). The Enter key still takes the app's normal send path.

Orientation is decided at runtime from `screen.orientation` and published as
`data-dsh-question-landscape` on the conversation body. A viewport-aspect media
query cannot be used: on a portrait phone the soft keyboard shrinks the layout
viewport below its width and `@media (orientation: landscape)` would flip to the
rail layout while the device is upright.

Implementation is one hand-written client bundle (`lib/client.js`) in the shared
tsdown client-bundle format, so there is no build step. That file is source, not
a build artifact; it is force-added because the repository ignores `lib/`
globally:

- one scoped stylesheet (`data-plugin="dsh-question-landscape"`), and
- a small layout effect: orientation gate, rail height measurement, the reply
  button, the chevron/scroll collapse, and focus hand-off.

Caveats:

- Selectors use the shipped UI's internal DOM attributes (`data-composer-seat`,
  `data-conversation-scroll`, `data-question-key`, `data-chain-overlay-fallback`,
  `aria-expanded` on the header toggle). A DSH change can make the effect stop
  applying; it only adds presentation and focus calls.
- The card's rail top is measured from the conversation body (header height and
  safe areas are layout-owned), and re-measured on resize, orientation, session
  switch, and card arrival.
- The plugin does not touch plan-review or approval cards.

Disable: remove `dsh-question-landscape` from the web profile's
`dsh.profile.bundles` (and its dependency/symlink) and restart dsh.
