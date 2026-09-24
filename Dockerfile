FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm test && npm run build

FROM scratch AS export
COPY --from=build /app/dist /

FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
USER root
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
