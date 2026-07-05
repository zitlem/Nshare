#!/bin/bash

# NFS Mount Setup Script for Debian 12
# This script automates NFS client installation and persistent mount configuration

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored messages
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    print_error "This script must be run as root (use sudo)"
    exit 1
fi

print_info "NFS Mount Setup Script"
echo "======================================"
echo

# Get NFS server details from user
read -p "Enter NFS server IP or hostname: " NFS_SERVER
read -p "Enter NFS share path (e.g., /exports/data): " NFS_SHARE_PATH
read -p "Enter local mount point (e.g., /mnt/nfs_share): " MOUNT_POINT

# Optional: Mount options
echo
print_info "Default mount options: defaults,_netdev,rw,soft,timeo=30"
read -p "Use default options? (y/n) [y]: " USE_DEFAULT
USE_DEFAULT=${USE_DEFAULT:-y}

if [[ "$USE_DEFAULT" != "y" && "$USE_DEFAULT" != "Y" ]]; then
    read -p "Enter custom mount options: " MOUNT_OPTIONS
else
    MOUNT_OPTIONS="defaults,_netdev,rw,soft,timeo=30"
fi

echo
print_info "Configuration Summary:"
echo "  NFS Server: $NFS_SERVER"
echo "  Share Path: $NFS_SHARE_PATH"
echo "  Mount Point: $MOUNT_POINT"
echo "  Options: $MOUNT_OPTIONS"
echo

read -p "Continue with this configuration? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    print_warning "Setup cancelled by user"
    exit 0
fi

echo
print_info "Step 1: Installing NFS client packages..."
apt update
apt install -y nfs-common

echo
print_info "Step 2: Creating mount point directory..."
mkdir -p "$MOUNT_POINT"
print_info "Created: $MOUNT_POINT"

echo
print_info "Step 3: Testing NFS server accessibility..."
if showmount -e "$NFS_SERVER" &>/dev/null; then
    print_info "NFS server is accessible"
    showmount -e "$NFS_SERVER"
else
    print_warning "Cannot reach NFS server or showmount failed"
    print_warning "Continuing anyway - server may be configured to hide exports"
fi

echo
print_info "Step 4: Creating backup of /etc/fstab..."
cp /etc/fstab /etc/fstab.backup.$(date +%Y%m%d_%H%M%S)
print_info "Backup created"

echo
print_info "Step 5: Adding NFS mount to /etc/fstab..."
FSTAB_ENTRY="$NFS_SERVER:$NFS_SHARE_PATH  $MOUNT_POINT  nfs  $MOUNT_OPTIONS  0  0"

# Check if entry already exists
if grep -q "$NFS_SERVER:$NFS_SHARE_PATH" /etc/fstab; then
    print_warning "An entry for this NFS share already exists in /etc/fstab"
    print_warning "Please edit /etc/fstab manually to avoid duplicates"
else
    echo "" >> /etc/fstab
    echo "# NFS mount added by setup-nfs-mount.sh on $(date)" >> /etc/fstab
    echo "$FSTAB_ENTRY" >> /etc/fstab
    print_info "Added to /etc/fstab"
fi

echo
print_info "Step 6: Mounting NFS share..."
if mount -a; then
    print_info "Mount successful!"
else
    print_error "Mount failed. Check the configuration and try manually:"
    echo "  sudo mount -t nfs $NFS_SERVER:$NFS_SHARE_PATH $MOUNT_POINT"
    exit 1
fi

echo
print_info "Step 7: Verifying mount..."
if mount | grep -q "$MOUNT_POINT"; then
    print_info "✓ NFS share is mounted successfully"
    echo
    df -h | grep "$MOUNT_POINT"
else
    print_error "Mount verification failed"
    exit 1
fi

echo
print_info "======================================"
print_info "Setup Complete!"
echo
echo "Your NFS share is now mounted at: $MOUNT_POINT"
echo "The mount will persist across reboots."
echo
echo "Useful commands:"
echo "  - Check mount status:  df -h | grep nfs"
echo "  - View NFS mounts:     mount | grep nfs"
echo "  - Unmount:             sudo umount $MOUNT_POINT"
echo "  - Remount all:         sudo mount -a"
echo "  - Test fstab:          sudo findmnt --verify"
echo
print_info "Backup of original /etc/fstab saved with .backup extension"
