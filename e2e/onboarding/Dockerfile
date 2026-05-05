FROM ubuntu:24.04

# A typical developer machine has: git, curl, sudo, a user account
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user (simulates a real developer)
RUN useradd -m -s /bin/bash developer && \
    echo "developer ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER developer
WORKDIR /home/developer
