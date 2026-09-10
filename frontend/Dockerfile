FROM node:25-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM dependencies AS build
COPY . .
RUN npm run build

FROM caddy:2.11-alpine AS production
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/build /usr/share/caddy
EXPOSE 80
