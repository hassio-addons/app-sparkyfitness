/*
 * SparkyFitness is built for the root of a host, and names addresses from
 * there throughout: the API at /api, uploaded pictures at /uploads, its own
 * images at /images. Under Ingress the root is Home Assistant's. The app lives
 * below a path Home Assistant picks per installation, which is only known once
 * a request arrives, so it cannot be built in.
 *
 * NGINX writes that path into the page as its base, and this reads it back.
 * Everything below then moves root addresses on to the base as they leave
 * the page: requests made with fetch and XMLHttpRequest, and the src and href
 * of elements. That covers the addresses the server stores in the database
 * too, like the path of an uploaded avatar, which no build time patch could.
 *
 * This matters more than it looks. The Ingress path itself starts with /api/,
 * so a request that slips past this does not fail as a missing page. It lands
 * on Home Assistant's own API, which answers with a 401 that looks like being
 * signed out.
 *
 * At the root of a host, which is how the published port serves the app, the
 * base is empty and none of this does anything.
 *
 * Loaded as a file of its own, before anything else on the page, so every
 * address is covered from the very first request on.
 */
(function () {
  'use strict';

  var base = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
  window.__sparkyBasePath = base;

  // The address Fitbit, Strava and the like send the browser back to after
  // approving SparkyFitness, when the app was told one. It is the page Home
  // Assistant shows the app on, which the settings show as the address to
  // register with them, in place of the address of this page.
  var callbackBase = document.querySelector(
    'meta[name="sparky-callback-base"]'
  );
  if (callbackBase) {
    window.__sparkyCallbackBase = callbackBase.getAttribute('content');
  }

  if (!base) {
    return;
  }

  var origin = window.location.origin;

  // Home Assistant shows the app at /app/<slug>, and loads it from the start
  // of the Ingress path whatever follows that. Whatever does follow, like the
  // /fitbit/callback?code=... a service sent the browser back to, is only in
  // the address of Home Assistant's own page. That page is on the same origin,
  // so it is read from there, and the app is started on it instead, before
  // the router looks. Home Assistant is then asked to drop it from its own
  // address, so that reloading the page does not play the callback again.
  try {
    var parent = window.parent;
    var panel = /^(\/app\/[^/]+)(\/.+)$/.exec(parent.location.pathname);
    if (parent !== window && panel && window.location.pathname === base + '/') {
      window.history.replaceState(
        window.history.state,
        '',
        base + panel[2] + parent.location.search
      );
      parent.postMessage(
        {
          type: 'home-assistant/navigate',
          path: panel[1],
          options: { replace: true },
        },
        origin
      );
    }
  } catch (err) {
    // Not framed by Home Assistant; nothing to pick up.
  }

  function rebase(value) {
    if (typeof value !== 'string') {
      return value;
    }

    var path;
    if (value.charAt(0) === '/') {
      // Protocol relative, which is somebody else's host.
      if (value.charAt(1) === '/') {
        return value;
      }
      path = value;
    } else if (value.indexOf(origin + '/') === 0) {
      path = value.slice(origin.length);
    } else {
      return value;
    }

    if (path === base || path.indexOf(base + '/') === 0) {
      return value;
    }

    return origin + base + path;
  }

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rebase(input);
    } else if (input instanceof URL) {
      input = rebase(input.href);
    } else if (input instanceof Request) {
      var url = rebase(input.url);
      if (url !== input.url) {
        input = new Request(url, input);
      }
    }
    return nativeFetch.call(this, input, init);
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rebase(url instanceof URL ? url.href : url);
    return nativeOpen.apply(this, args);
  };

  // React sets src and href through setAttribute. Everything else, like an
  // image preloaded with `new Image()`, goes through the properties.
  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var lower = String(name).toLowerCase();
    if (lower === 'src' || lower === 'href' || lower === 'poster') {
      value = rebase(String(value));
    }
    return nativeSetAttribute.call(this, name, value);
  };

  function rebaseProperty(prototype, property) {
    var descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || !descriptor.set) {
      return;
    }
    Object.defineProperty(prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) {
        descriptor.set.call(this, rebase(String(value)));
      },
    });
  }

  rebaseProperty(HTMLImageElement.prototype, 'src');
  rebaseProperty(HTMLSourceElement.prototype, 'src');
  rebaseProperty(HTMLMediaElement.prototype, 'src');
  rebaseProperty(HTMLAnchorElement.prototype, 'href');
})();
