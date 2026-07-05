#!/bin/bash

# Detect which network management system is in use
detect_network_manager() {
  if systemctl is-active --quiet NetworkManager; then
    echo "networkmanager"
  elif systemctl is-active --quiet systemd-networkd; then
    echo "netplan"
  else
    echo "unknown"
  fi
}

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Return 0 if the argument looks like an IPv4 or IPv6 address (used to reject
# junk like "(ens20):" that resolvectl can emit for interfaces with no DNS).
is_ip() {
  local x="$1"
  [[ "$x" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && return 0   # IPv4
  [[ "$x" == *:* && "$x" =~ ^[0-9a-fA-F:]+$ ]] && return 0   # IPv6
  return 1
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  print_error "This script must be run as root (use sudo)"
  exit 1
fi

NETWORK_SYSTEM=$(detect_network_manager)

if [ "$NETWORK_SYSTEM" == "unknown" ]; then
  print_error "Could not detect network management system (NetworkManager or Netplan)."
  exit 1
fi

print_info "Detected network system: $NETWORK_SYSTEM"
echo

# List ALL non-loopback interfaces (including DOWN / unconfigured ones)
echo "Available network interfaces:"

INTERFACES=$(ip -o link show | awk -F': ' '{print $2}' | grep -v '^lo$')

if [ -z "$INTERFACES" ]; then
  print_error "No network interfaces found. Exiting."
  exit 1
fi

counter=1
declare -A INTERFACE_LIST
declare -A INTERFACE_STATE
declare -A INTERFACE_IP
declare -A INTERFACE_DNS

while IFS= read -r NAME; do
  [ -z "$NAME" ] && continue

  # Operational state (UP / DOWN)
  STATE=$(ip -o link show "$NAME" | grep -o 'state [A-Z]*' | awk '{print $2}')
  [ -z "$STATE" ] && STATE="UNKNOWN"

  MAC_ADDRESS=$(ip -o link show "$NAME" | awk '{for (i=1;i<=NF;i++) if ($i=="link/ether") print $(i+1)}')
  [ -z "$MAC_ADDRESS" ] && MAC_ADDRESS="(none)"

  # Current IPv4 (may be empty for a DOWN / unconfigured NIC)
  CUR_IP=$(ip -o -4 addr show dev "$NAME" 2>/dev/null | awk '{print $4}' | head -n1)
  [ -z "$CUR_IP" ] && CUR_IP="—"

  # DNS (best-effort). Strip the "Global:" / "Link N (iface):" prefix so an
  # interface with NO dns doesn't yield junk like "(ens20):", then validate.
  if [ "$NETWORK_SYSTEM" == "networkmanager" ]; then
    DNS=$(nmcli device show "$NAME" 2>/dev/null | awk '/IP4.DNS/{print $2; exit}')
  else
    DNS=$(resolvectl dns "$NAME" 2>/dev/null \
          | sed -E 's/^(Global|Link[[:space:]]+[0-9]+[[:space:]]+\([^)]*\)):[[:space:]]*//' \
          | awk '{print $1; exit}')
    [ -z "$DNS" ] && DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)
  fi
  is_ip "$DNS" || DNS=""
  [ -z "$DNS" ] && DNS="(none)"

  INTERFACE_LIST["$counter"]="$NAME"
  INTERFACE_STATE["$counter"]="$STATE"
  INTERFACE_IP["$counter"]="$CUR_IP"
  INTERFACE_DNS["$counter"]="$DNS"

  echo "$counter) $NAME - $STATE - IP: $CUR_IP - MAC: $MAC_ADDRESS - DNS: $DNS"
  ((counter++))
done <<< "$INTERFACES"

EXIT_OPTION=$counter
echo "$EXIT_OPTION) Exit"
echo

echo "Enter the number of the interface you want to configure, or select the exit option:"
read SELECTED_OPTION

if [ "$SELECTED_OPTION" == "$EXIT_OPTION" ]; then
  print_info "Exiting script."
  exit 0
fi

if [[ ! "$SELECTED_OPTION" =~ ^[0-9]+$ ]] || [ -z "${INTERFACE_LIST[$SELECTED_OPTION]}" ]; then
  print_error "Invalid selection. Exiting."
  exit 1
fi

INTERFACE_NAME="${INTERFACE_LIST[$SELECTED_OPTION]}"
SELECTED_STATE="${INTERFACE_STATE[$SELECTED_OPTION]}"
CURRENT_IP="${INTERFACE_IP[$SELECTED_OPTION]}"
CURRENT_DNS="${INTERFACE_DNS[$SELECTED_OPTION]}"
[ "$CURRENT_IP" == "—" ] && CURRENT_IP=""
[ "$CURRENT_DNS" == "(none)" ] && CURRENT_DNS=""

echo
print_info "Selected interface: $INTERFACE_NAME (state: $SELECTED_STATE)"

# Bring the link up if it is down, so it becomes usable immediately
if [ "$SELECTED_STATE" != "UP" ]; then
  print_info "Interface is $SELECTED_STATE — bringing it up (ip link set $INTERFACE_NAME up)..."
  ip link set "$INTERFACE_NAME" up
  sleep 1
  # Warn if there is no carrier (e.g. Proxmox vNIC not attached to a bridge/VLAN)
  if ip -o link show "$INTERFACE_NAME" | grep -q "NO-CARRIER"; then
    print_warning "$INTERFACE_NAME has NO-CARRIER — the link is up but not connected."
    print_warning "On a VM, attach this NIC to the correct bridge/VLAN in the hypervisor."
  fi
fi

# Current gateway on this interface (may be empty — that's fine for a secondary NIC)
CURRENT_GATEWAY=$(ip route show default 2>/dev/null | grep "dev $INTERFACE_NAME" | awk '{print $3}' | head -n1)

echo
[ -n "$CURRENT_IP" ]      && echo "Current IP:      $CURRENT_IP"
[ -n "$CURRENT_GATEWAY" ] && echo "Current Gateway: $CURRENT_GATEWAY"
[ -n "$CURRENT_DNS" ]     && echo "Current DNS:     $CURRENT_DNS"
echo

# Prompt for static IP (required if the interface has none)
if [ -n "$CURRENT_IP" ]; then
  read -p "Static IP [default: $CURRENT_IP]: " STATIC_IP
  STATIC_IP="${STATIC_IP:-$CURRENT_IP}"
else
  read -p "Static IP (e.g. 192.168.4.8/24): " STATIC_IP
fi

if [ -z "$STATIC_IP" ]; then
  print_error "No IP address provided. Exiting."
  exit 1
fi

# Add /24 only when no CIDR suffix was given
if [[ "$STATIC_IP" != */* ]]; then
  STATIC_IP="$STATIC_IP/24"
fi

# Validate the address portion
if ! is_ip "${STATIC_IP%/*}"; then
  print_error "Invalid IP address: $STATIC_IP"
  exit 1
fi

# Gateway is OPTIONAL — blank means no default route (correct for a secondary subnet NIC)
echo
print_info "Gateway is optional. Leave blank for a secondary interface (no default route)."
if [ -n "$CURRENT_GATEWAY" ]; then
  read -p "Gateway [default: $CURRENT_GATEWAY, '-' for none]: " STATIC_GATEWAY
  STATIC_GATEWAY="${STATIC_GATEWAY:-$CURRENT_GATEWAY}"
else
  read -p "Gateway [blank for none]: " STATIC_GATEWAY
fi
[ "$STATIC_GATEWAY" == "-" ] && STATIC_GATEWAY=""
if [ -n "$STATIC_GATEWAY" ] && ! is_ip "$STATIC_GATEWAY"; then
  print_warning "Gateway '$STATIC_GATEWAY' is not a valid IP — ignoring."
  STATIC_GATEWAY=""
fi

# DNS is OPTIONAL
if [ -n "$CURRENT_DNS" ]; then
  read -p "DNS [default: $CURRENT_DNS, '-' for none]: " STATIC_DNS
  STATIC_DNS="${STATIC_DNS:-$CURRENT_DNS}"
else
  read -p "DNS [blank for none]: " STATIC_DNS
fi
[ "$STATIC_DNS" == "-" ] && STATIC_DNS=""
if [ -n "$STATIC_DNS" ] && ! is_ip "$STATIC_DNS"; then
  print_warning "DNS '$STATIC_DNS' is not a valid IP — ignoring."
  STATIC_DNS=""
fi

echo
print_info "Applying configuration:"
echo "  Interface: $INTERFACE_NAME"
echo "  Static IP: $STATIC_IP"
echo "  Gateway:   ${STATIC_GATEWAY:-<none>}"
echo "  DNS:       ${STATIC_DNS:-<none>}"
echo
read -p "Continue? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  print_warning "Cancelled by user."
  exit 0
fi

if [ "$NETWORK_SYSTEM" == "networkmanager" ]; then
  echo
  print_info "Using NetworkManager (nmcli)..."

  CONNECTION_NAME=$(nmcli -g GENERAL.CONNECTION device show "$INTERFACE_NAME" 2>/dev/null)

  if [ -z "$CONNECTION_NAME" ] || [ "$CONNECTION_NAME" == "--" ]; then
    # No existing connection (fresh DOWN NIC) — create one
    CONNECTION_NAME="$INTERFACE_NAME"
    print_info "No active connection — creating '$CONNECTION_NAME'..."
    nmcli con add type ethernet ifname "$INTERFACE_NAME" con-name "$CONNECTION_NAME" \
      ipv4.method manual ipv4.addresses "$STATIC_IP"
  else
    print_info "Modifying existing connection: $CONNECTION_NAME"
    nmcli con mod "$CONNECTION_NAME" ipv4.method manual ipv4.addresses "$STATIC_IP"
  fi

  # Gateway / DNS only when provided
  if [ -n "$STATIC_GATEWAY" ]; then
    nmcli con mod "$CONNECTION_NAME" ipv4.gateway "$STATIC_GATEWAY"
  else
    nmcli con mod "$CONNECTION_NAME" ipv4.gateway ""
  fi
  if [ -n "$STATIC_DNS" ]; then
    nmcli con mod "$CONNECTION_NAME" ipv4.dns "$STATIC_DNS"
  else
    nmcli con mod "$CONNECTION_NAME" ipv4.dns ""
  fi

  nmcli con down "$CONNECTION_NAME" 2>/dev/null
  if nmcli con up "$CONNECTION_NAME"; then
    print_info "Connection applied."
  else
    print_error "Failed to bring the connection up. Check: nmcli con show \"$CONNECTION_NAME\""
    exit 1
  fi

else
  echo
  print_info "Using Netplan (systemd-networkd)..."

  # Write a DEDICATED per-interface file so other interfaces are never touched.
  NETPLAN_FILE="/etc/netplan/90-${INTERFACE_NAME}.yaml"

  # Warn if this interface is already defined elsewhere in /etc/netplan
  OTHER_DEFS=$(grep -rl "^[[:space:]]*${INTERFACE_NAME}:" /etc/netplan/ 2>/dev/null | grep -v "^${NETPLAN_FILE}$")
  if [ -n "$OTHER_DEFS" ]; then
    print_warning "$INTERFACE_NAME is also defined in: $(echo "$OTHER_DEFS" | tr '\n' ' ')"
    print_warning "The higher-numbered netplan file wins on conflicting keys."
  fi

  print_info "Backing up /etc/netplan..."
  cp -r /etc/netplan "/etc/netplan.backup.$(date +%Y%m%d_%H%M%S)"

  # Build the YAML (routes / nameservers included only if provided)
  {
    echo "network:"
    echo "  version: 2"
    echo "  renderer: networkd"
    echo "  ethernets:"
    echo "    ${INTERFACE_NAME}:"
    echo "      dhcp4: no"
    echo "      addresses:"
    echo "        - $STATIC_IP"
    if [ -n "$STATIC_GATEWAY" ]; then
      echo "      routes:"
      echo "        - to: default"
      echo "          via: $STATIC_GATEWAY"
    fi
    if [ -n "$STATIC_DNS" ]; then
      echo "      nameservers:"
      echo "        addresses:"
      echo "          - $STATIC_DNS"
    fi
  } > "$NETPLAN_FILE"

  chmod 600 "$NETPLAN_FILE"
  print_info "Wrote $NETPLAN_FILE (only $INTERFACE_NAME; other interfaces untouched)."

  print_info "Testing configuration (netplan try, auto-reverts on failure)..."
  if netplan try --timeout 20; then
    print_info "Configuration accepted and applied."
  else
    print_error "netplan try failed — removing $NETPLAN_FILE and reverting."
    rm -f "$NETPLAN_FILE"
    netplan apply
    exit 1
  fi
fi

echo
print_info "======================================"
print_info "Done. $INTERFACE_NAME configured:"
echo "  IP:      $STATIC_IP"
echo "  Gateway: ${STATIC_GATEWAY:-<none>}"
echo "  DNS:     ${STATIC_DNS:-<none>}"
echo
echo "Verify: ip a show $INTERFACE_NAME ; ip route"
