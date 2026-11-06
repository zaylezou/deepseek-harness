// dsh-restart-anywhere — browser half: two rows above Settings in the left
// sidebar (icon only when the sidebar is collapsed to its rail):
//   ↻ Restart dsh            — immediate: running sessions are interrupted and
//                              resumed after the restart.
//   ⏳ Restart when idle      — safe: waits for every running turn to finish,
//                              then restarts. Nothing is cut off.
// Click -> confirm -> POST, then poll until a server with a new boot id
// answers, then reload. Hidden only where restart isn't supported (desktop app).
window.__ModuleLoader__.load({ id: "dsh-restart-anywhere", factory: (require) => {
  var module = { exports: {} };
  const react = require("react");
  const h = react.createElement;
  const ROUTE = "api/dsh-restart"; // relative: works under a path prefix too

  const base = {
    height: 32, border: "none", borderRadius: 8, background: "transparent", font: "inherit", fontSize: 14,
    color: "var(--dsw-alias-label-secondary, currentColor)", display: "flex",
    alignItems: "center", gap: 8, cursor: "pointer"
  };
  const wideStyle = Object.assign({}, base, { width: "100%", padding: "0 10px" });
  const railStyle = Object.assign({}, base, { width: 32, padding: 0, justifyContent: "center", margin: "0 auto" });

  function Icon(props) {
    return h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
      style: props.spin ? { animation: "dsh-sr-spin 1s linear infinite" } : undefined },
      h("style", null, "@keyframes dsh-sr-spin{to{transform:rotate(360deg)}}"),
      h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }), h("path", { d: "M21 3v6h-6" }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const info = () => fetch(ROUTE, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null), () => null);

  /**
   * Wait until a server with a different boot id answers: robust however fast or
   * slow the restart is. `onTick` sees every poll, so a cancelled safe restart
   * (no longer draining, same boot) can be told apart from a slow one.
   */
  async function waitForNewBoot(oldBoot, onTick) {
    for (let i = 0; i < 300; i++) {
      await sleep(1000);
      const b = await info();
      if (b && b.boot && b.boot !== oldBoot) return true;
      if (onTick) onTick(b);
    }
    return false;
  }

  function Shell(props) {
    const label = props.label;
    return h("button", { type: "button", style: props.wide ? wideStyle : railStyle, title: label, "aria-label": label,
      disabled: props.busy, onClick: props.onClick,
      onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"; },
      onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; } },
      h(Icon, { spin: props.busy }), props.wide ? h("span", null, label) : null);
  }

  function RestartButton(props) {
    const [how, setHow] = react.useState(null);
    const [phase, setPhase] = react.useState("idle");
    react.useEffect(() => { info().then(setHow); }, []);
    if (!how || !how.mode) return null;

    const onClick = async () => {
      if (phase === "busy") return;
      const via = how.mode === "systemd" ? "systemd (" + how.unit + ")" : "an in-place restart";
      if (!window.confirm("Restart dsh via " + via + "?\nRunning sessions will be interrupted, then resumed automatically after the restart.")) return;
      setPhase("busy");
      try {
        const res = await fetch(ROUTE, { method: "POST" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
        if (await waitForNewBoot(how.boot)) return window.location.reload();
        throw new Error("dsh did not come back within 5 minutes");
      } catch (e) {
        setPhase("idle");
        window.alert("Restart failed: " + (e && e.message ? e.message : e));
      }
    };

    return h(Shell, { wide: props.wide, busy: phase === "busy", onClick,
      label: phase === "busy" ? "Restarting dsh…" : "Restart dsh" });
  }

  function SafeRestartButton(props) {
    const [how, setHow] = react.useState(null);
    const [phase, setPhase] = react.useState("idle"); // idle | waiting
    const [waiting, setWaiting] = react.useState(0);
    react.useEffect(() => { info().then(setHow); }, []);
    if (!how || !how.mode) return null;

    const onClick = async () => {
      if (phase === "waiting") return;
      if (!window.confirm("Restart dsh after every session has finished the turn it is running?\n"
        + "Nothing is cut off. This waits up to 2 minutes; if a session is still working then, the restart is cancelled.")) return;
      setPhase("waiting");
      try {
        const res = await fetch(ROUTE + "?when=idle&wait=120", { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
        setWaiting(body.waiting || 0);
        let cancelled = false;
        const arrived = await waitForNewBoot(how.boot, (b) => {
          if (b && b.draining) setWaiting(b.draining.waiting || 0);
          else if (b && !b.draining && b.boot === how.boot) cancelled = true;
        });
        if (arrived) return window.location.reload();
        setPhase("idle");
        window.alert(cancelled
          ? "The safe restart was cancelled: sessions were still working after the wait. Nothing was interrupted."
          : "dsh did not come back within 5 minutes.");
      } catch (e) {
        setPhase("idle");
        window.alert("Safe restart failed: " + (e && e.message ? e.message : e));
      }
    };

    const label = phase === "waiting"
      ? (waiting > 0 ? "Waiting for " + waiting + " session" + (waiting === 1 ? "" : "s") + "…" : "Restarting dsh…")
      : "Restart when idle";
    return h(Shell, { wide: props.wide, busy: phase === "waiting", onClick, label });
  }

  module.exports.inject = ["slots"];
  module.exports.apply = function (ctx) {
    ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-restart-anywhere", order: 10 }, RestartButton)),
      "dsh-restart-anywhere: sidebar button");
    ctx.effect(() => ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register({ name: "sidebar.footer.action", id: "dsh-restart-anywhere-idle", order: 11 }, SafeRestartButton)),
      "dsh-restart-anywhere: sidebar safe button");
  };
  return module.exports;
} });
