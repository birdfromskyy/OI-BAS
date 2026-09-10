FROM golang:1.26-alpine AS base
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

FROM base AS development
EXPOSE 8080
ENTRYPOINT ["go", "run", "./cmd/api"]

FROM base AS build
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /api ./cmd/api

FROM alpine:3.22 AS production
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 app
COPY --from=build /api /api
USER app
EXPOSE 8080
ENTRYPOINT ["/api"]
