# syntax=docker/dockerfile:1
# Multi-stage build: compile the frontend, compile the Go backend, then ship a
# minimal runtime image that carries ffmpeg (used for probing, thumbnails, and
# export) and serves the built UI from the backend.

FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /studio ./cmd/studio

FROM alpine:3.20
RUN apk add --no-cache ffmpeg ca-certificates
WORKDIR /app
COPY --from=backend /studio /app/studio
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# STUDIO_TOKEN gates the API (unset = open). STUDIO_ALLOWED_ORIGINS is a comma
# list of CORS origins. Media persists under the /data volume.
ENV STUDIO_TOKEN="" \
    STUDIO_ALLOWED_ORIGINS=""
EXPOSE 8788
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8788/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/studio", "-addr", ":8788", "-root", "/app", "-media", "/data", "-front", "/app/frontend/dist"]
