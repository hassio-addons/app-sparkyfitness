server {
    {{ if not .ssl }}
    listen {{ .port }} default_server;
    {{ else }}
    listen {{ .port }} default_server ssl;
    http2 on;
    {{ end }}

    include /etc/nginx/includes/server_params.conf;
    include /etc/nginx/includes/proxy_params.conf;

    {{ if .ssl }}
    include /etc/nginx/includes/ssl_params.conf;

    ssl_certificate /ssl/{{ .certfile }};
    ssl_certificate_key /ssl/{{ .keyfile }};
    {{ end }}

    # See the map in nginx.conf.
    proxy_set_header Origin $direct_origin;

    # Nobody is signed in by name here, whatever a request claims.
    proxy_set_header X-Sparky-HA-User-Id "";
    proxy_set_header X-Sparky-HA-User-Name "";
    proxy_set_header X-Sparky-HA-User-Display-Name "";

    {{ if .callback_base }}
    # The address the services SparkyFitness connects to send the browser back
    # to, for the client to show. See patches/ha-base-path.js.
    sub_filter_once on;
    sub_filter '<base href="/" />' '<base href="/" /><meta name="sparky-callback-base" content="{{ .callback_base }}" />';
    {{ end }}

    include /etc/nginx/includes/locations.conf;
}
