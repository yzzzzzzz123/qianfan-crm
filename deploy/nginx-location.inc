# Included only in the qfspark.thousand-sails.com HTTPS server.
location = /crm { return 308 /qf-crm/; }
location ^~ /crm/ {
    return 308 /qf-crm/;
    access_log off;
}
location = /qf-crm { return 308 /qf-crm/; }
location ^~ /qf-crm/ {
    proxy_pass http://127.0.0.1:5310/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_read_timeout 480s;
    proxy_send_timeout 120s;
    client_max_body_size 30m;
    access_log off;
    error_log /dev/null crit;
}
