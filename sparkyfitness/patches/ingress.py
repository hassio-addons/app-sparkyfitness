#!/usr/bin/env python3
"""Make SparkyFitness at home under Home Assistant Ingress.

SparkyFitness is built to be served from the root of a host. Ingress has no
root to give it: the app is served below a path Home Assistant picks, which is
only known once a request arrives. And Home Assistant knows who is asking, so
there is no reason to make them sign in a second time.

This runs in two steps. `source` edits the checked out source before it is
built: the client learns to route below a base, and the server gets the
middleware that signs Home Assistant users in, and stops listening on anything
but loopback. `dist` then points the built page at the base NGINX writes into
it, and loads the shim that moves the client's root addresses on to that base.

Every substitution states what it expects to match and stops the build if it
does not, which turns a quietly half patched app into a failed build when
upstream changes shape.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent
SHIM = "ha-base-path.js"
MIDDLEWARE = "homeAssistantIngressAuth.ts"

# What the client knows as its base: empty at the root of a host, and the
# Ingress path, without a trailing slash, below it. Set by the shim.
BASE = "(window.__sparkyBasePath || '')"


class PatchError(Exception):
    """A substitution did not match what it was written against."""


def substitute(path: Path, old: str, new: str, *, expected: int = 1) -> None:
    """Replace a literal string in a file, insisting on the number of matches."""
    text = path.read_text(encoding="utf-8")
    found = text.count(old)
    if found != expected:
        raise PatchError(
            f"{path}: expected {expected} match(es) of {old!r}, found {found}"
        )
    path.write_text(text.replace(old, new), encoding="utf-8")


def patch_frontend(root: Path) -> None:
    """Teach the client to live below a base it learns at runtime."""
    frontend = root / "SparkyFitnessFrontend"

    # Assets are addressed relative to the page, so they resolve against
    # whatever base the page states.
    substitute(
        frontend / "vite.config.ts", "  return {\n", "  return {\n    base: './',\n"
    )

    # The service worker is left out. It would register against the root,
    # which under Ingress is Home Assistant's, and what it offers is keeping
    # the app cached for offline use. For an app that is only reachable while
    # Home Assistant is, that buys nothing and costs a class of bug where an
    # update is served out of yesterday's cache.
    substitute(
        frontend / "vite.config.ts",
        "      mode === 'production' &&\n        VitePWA({",
        "      false &&\n        VitePWA({",
    )

    app = frontend / "src" / "App.tsx"

    # Without a basename the router reads the Ingress path as a route, finds
    # nothing there, and every link it renders leads out of Ingress.
    substitute(
        app,
        "const router = createBrowserRouter([",
        "const router = ((routes: Parameters<typeof createBrowserRouter>[0]) =>\n"
        f"  createBrowserRouter(routes, {{ basename: {BASE} || '/' }}))([",
    )

    # Paths read straight off the address bar include the base, which the
    # router adds again on navigating. They are taken without it.
    substitute(
        app,
        "window.location.pathname.replace(/\\/+/g, '/')",
        f"window.location.pathname.slice({BASE}.length).replace(/\\/+/g, '/')",
    )
    substitute(
        frontend / "src" / "pages" / "Diary" / "ExerciseCard.tsx",
        "`${window.location.pathname}${window.location.search}`",
        f"`${{window.location.pathname.slice({BASE}.length)}}${{window.location.search}}`",
    )

    # Signing out reloads the page at the root, which would be Home
    # Assistant's front page, inside the Ingress frame.
    substitute(
        frontend / "src" / "hooks" / "useAuth.tsx",
        "window.location.href = '/';",
        f"window.location.href = {BASE} + '/';",
    )

    # Connecting Fitbit, Strava and the like sends the browser to their site
    # to approve SparkyFitness. Those sites refuse to be shown inside a frame,
    # which is what the app is under Ingress, so the whole window goes there.
    providers = frontend / "src" / "api" / "Settings" / "externalProviderService.ts"
    substitute(
        providers,
        "window.location.href = response.authUrl;",
        "(window.top || window).location.href = response.authUrl;",
        expected=5,
    )
    substitute(
        providers,
        "window.location.href = response.url;",
        "(window.top || window).location.href = response.url;",
    )

    # Those sites send the browser back to an address registered with them
    # beforehand, which the settings show to copy from. Under Ingress that is
    # the page Home Assistant shows the app on, not the page itself.
    settings = frontend / "src" / "pages" / "Settings"
    for name, expected in (
        ("ProviderSpecificFields.tsx", 3),
        ("EditProviderForm.tsx", 9),
    ):
        substitute(
            settings / name,
            "${window.location.origin}/",
            "${window.__sparkyCallbackBase || window.location.origin}/",
            expected=expected,
        )


def patch_server(root: Path) -> None:
    """Sign Home Assistant users in, and keep the server to loopback."""
    server = root / "SparkyFitnessServer"
    main = server / "SparkyFitnessServer.ts"

    shutil.copyfile(HERE / MIDDLEWARE, server / "middleware" / MIDDLEWARE)

    substitute(
        main,
        "import cookieParser from 'cookie-parser';\n",
        "import cookieParser from 'cookie-parser';\n"
        "import { homeAssistantIngressAuth } from './middleware/"
        f"{MIDDLEWARE.removesuffix('.ts')}.js';\n",
    )

    # After the cookies are parsed, since it replaces the session cookie, and
    # before anything that looks at the session: the Better Auth handler right
    # below, and the authentication of every other route further down.
    substitute(
        main,
        "app.use(cookieParser());\n",
        "app.use(cookieParser());\napp.use(homeAssistantIngressAuth);\n",
    )

    # The address the services SparkyFitness connects to send the browser back
    # to, which is the page Home Assistant shows the app on, when the user
    # named it. See init-sparkyfitness.
    callback_base = (
        "(process.env.SPARKY_FITNESS_OAUTH_CALLBACK_BASE"
        " || process.env.SPARKY_FITNESS_FRONTEND_URL)"
    )
    for path, expected in (
        ("routes/fitbitRoutes.ts", 2),
        ("routes/googleHealthRoutes.ts", 2),
        ("routes/ouraRoutes.ts", 2),
        ("routes/polarRoutes.ts", 2),
        ("routes/stravaRoutes.ts", 1),
        ("routes/withingsRoutes.ts", 1),
        ("integrations/withings/withingsService.ts", 1),
    ):
        substitute(
            server / path,
            "process.env.SPARKY_FITNESS_FRONTEND_URL",
            callback_base,
            expected=expected,
        )

    # NGINX is the only thing meant to talk to the server, and the one place
    # that decides whether a request carries a Home Assistant user. Listening
    # on every interface would let anything else on the Supervisor's network
    # hand the server a user of its choosing.
    substitute(
        main,
        "const server = app.listen(PORT);",
        "const server = app.listen(Number(PORT), '127.0.0.1');",
    )


def patch_dist(dist: Path) -> None:
    """Point the built page at the base, and load the shim before the client."""
    index = dist / "index.html"
    text = index.read_text(encoding="utf-8")

    # Every address the page loads itself through, made relative to the base.
    text, rewritten = re.subn(r'(href|src)="/(?!/)', r'\1="', text)
    remaining = re.findall(r"""(?:href|src)=["']/(?!/)""", text)
    if remaining:
        raise PatchError(
            f"{index}: {len(remaining)} address(es) still point at the site root"
        )

    # NGINX rewrites this tag on the way out. The shim has to come before the
    # client, and after the base, which it reads.
    if text.count("<head>") != 1:
        raise PatchError(f"{index}: expected exactly one <head>")
    text = text.replace(
        "<head>",
        f'<head>\n    <base href="/" />\n    <script src="{SHIM}"></script>',
    )
    index.write_text(text, encoding="utf-8")

    # The manifest names the icons and the start address from the root, which
    # is outside of the app under Ingress.
    manifest = dist / "manifest.json"
    text = manifest.read_text(encoding="utf-8")
    text, manifest_rewritten = re.subn(r'"/(?!/)', '"./', text)
    if not manifest_rewritten:
        raise PatchError(f"{manifest}: no root-relative addresses found")
    manifest.write_text(text, encoding="utf-8")

    shutil.copyfile(HERE / SHIM, dist / SHIM)

    print(f"Patched the built client in {dist}")
    print(f"  index.html: base tag, {SHIM}, {rewritten} address(es) made relative")
    print(f"  manifest.json: {manifest_rewritten} address(es) made relative")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("source", "dist"):
        print(f"usage: {argv[0]} source <checkout> | dist <build>", file=sys.stderr)
        return 2

    target = Path(argv[2])
    try:
        if argv[1] == "source":
            patch_frontend(target)
            patch_server(target)
            print(f"Patched the SparkyFitness source in {target}")
        else:
            patch_dist(target)
    except PatchError as err:
        print(f"Patching SparkyFitness failed: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
