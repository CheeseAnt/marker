# --- Stage 1: Build the SPA ---
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package management files first for efficient caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy remaining project source files
COPY . .

# Build the SPA (runs your build scripts and outputs to dist)
RUN npm run build

# --- Stage 2: Serve static files with Nginx ---
FROM nginx:alpine

# Copy custom Nginx configuration for SPA routing
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Copy build artifacts from Stage 1 (change /dist if your build output folder is build)
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
