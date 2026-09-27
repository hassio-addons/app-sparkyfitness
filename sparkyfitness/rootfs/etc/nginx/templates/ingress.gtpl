server {
    listen {{ .interface }}:{{ .port }} default_server;

    include /etc/nginx/includes/server_params.conf;
    include /etc/nginx/includes/proxy_params.conf;

    allow   172.30.32.2;
    deny    all;

    # Only Home Assistant reaches this server, and only for somebody it has
    # already let in. What they send is same-origin by construction, so it is
    # presented to SparkyFitness under the one origin it trusts.
    proxy_set_header Origin "http://sparkyfitness.invalid";

    {{ if .auto_login }}
    # Who is asking, as Home Assistant says. The Supervisor sets these headers
    # itself, and drops any copy that arrived with the request, so no browser
    # can put a name here. SparkyFitness signs that person in, see
    # patches/homeAssistantIngressAuth.ts.
    proxy_set_header X-Sparky-HA-User-Id $http_x_remote_user_id;
    proxy_set_header X-Sparky-HA-User-Name $http_x_remote_user_name;
    proxy_set_header X-Sparky-HA-User-Display-Name $http_x_remote_user_display_name;
    {{ else }}
    proxy_set_header X-Sparky-HA-User-Id "";
    proxy_set_header X-Sparky-HA-User-Name "";
    proxy_set_header X-Sparky-HA-User-Display-Name "";
    {{ end }}

    # The client is built for the root of a host, which under Ingress is Home
    # Assistant's. The page states the base everything resolves against, and
    # this is where the path Home Assistant serves the app below is written
    # into it. See patches/ha-base-path.js for the rest.
    sub_filter_once on;
    {{ if .callback_base }}
    sub_filter '<base href="/" />' '<base href="$ingress_base/" /><meta name="sparky-callback-base" content="{{ .callback_base }}" />';
    {{ else }}
    sub_filter '<base href="/" />' '<base href="$ingress_base/" />';
    {{ end }}

    include /etc/nginx/includes/locations.conf;
}
