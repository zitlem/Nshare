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

NETWORK_SYSTEM=$(detect_network_manager)

if [ "$NETWORK_SYSTEM" == "unknown" ]; then
  echo "Error: Could not detect network management system (NetworkManager or Netplan)."
  exit 1
fi

echo "Detected network system: $NETWORK_SYSTEM"
echo

# List all network interfaces with their IP addresses using 'ip a'
echo "Available network interfaces (Name, IP, MAC):"

# Get the list of interfaces, IP addresses using 'ip a', excluding 'lo' (loopback interface)
INTERFACES=$(ip -o -4 addr show | awk '{print $2, $4}' | grep -v "lo")

# If no interfaces are found, exit
if [ -z "$INTERFACES" ]; then
  echo "No active network interfaces found. Exiting."
  exit 1
fi

# Display the interfaces to the user as a numbered list
counter=1
declare -A INTERFACE_LIST
declare -A INTERFACE_MACS
declare -A INTERFACE_DNS
while IFS=' ' read -r NAME IP; do
  MAC_ADDRESS=$(ip link show "$NAME" | awk '/link/ {print $2}')
  
  # Get DNS based on network system
  if [ "$NETWORK_SYSTEM" == "networkmanager" ]; then
    INTERFACE_DNS[$counter]=$(nmcli device show "$NAME" | grep "IP4.DNS" | awk '{print $2}' | head -n 1)
  else
    # For netplan/systemd-networkd, get DNS from resolv.conf or systemd-resolve
    INTERFACE_DNS[$counter]=$(systemd-resolve --status "$NAME" 2>/dev/null | grep "DNS Servers" | awk '{print $3}' | head -n 1)
    [ -z "${INTERFACE_DNS[$counter]}" ] && INTERFACE_DNS[$counter]=$(grep nameserver /etc/resolv.conf | head -n1 | awk '{print $2}')
  fi
  
  INTERFACE_LIST["$counter"]="$NAME:$IP"
  INTERFACE_MACS["$counter"]="$MAC_ADDRESS"
  
  # Show the output in a nice format
  echo "$counter) $NAME - IP: $IP, MAC: $MAC_ADDRESS, DNS: ${INTERFACE_DNS[$counter]}"
  ((counter++))
done <<< "$INTERFACES"

# Add the "Exit" option as the next sequential number
EXIT_OPTION=$counter
echo "$EXIT_OPTION) Exit"

echo

# Prompt user to select an interface by number, or select the exit option
echo "Enter the number of the interface you want to configure, or select the exit option:"
read SELECTED_OPTION

# If the user chooses to exit
if [ "$SELECTED_OPTION" == "$EXIT_OPTION" ]; then
  echo "Exiting script."
  exit 0
fi

# Validate the selection (check if it's a valid interface number)
if [[ ! "$SELECTED_OPTION" =~ ^[0-9]+$ ]] || [ -z "${INTERFACE_LIST[$SELECTED_OPTION]}" ]; then
  echo "Invalid selection. Exiting."
  exit 1
fi

# Extract the interface name, IP, MAC address, and DNS from the selected option
SELECTED_INTERFACE=$(echo "${INTERFACE_LIST[$SELECTED_OPTION]}")
INTERFACE_NAME=$(echo "$SELECTED_INTERFACE" | cut -d: -f1)
CURRENT_IP=$(echo "$SELECTED_INTERFACE" | cut -d: -f2)
MAC_ADDRESS=${INTERFACE_MACS[$SELECTED_OPTION]}
CURRENT_DNS=${INTERFACE_DNS[$SELECTED_OPTION]}

echo "Selected interface: $INTERFACE_NAME"
echo "Current IP Address: $CURRENT_IP"
echo "MAC Address: $MAC_ADDRESS"
echo "Current DNS: $CURRENT_DNS"
echo

# Fetch current Gateway using ip route
CURRENT_GATEWAY=$(ip route show | grep "$INTERFACE_NAME" | grep default | awk '{print $3}')

# If no Gateway is found, exit
if [ -z "$CURRENT_GATEWAY" ]; then
  echo "Unable to fetch Gateway info. Exiting."
  exit 1
fi

echo "Current Gateway: $CURRENT_GATEWAY"
echo

# Prompt the user for custom values (defaults to current values)
echo "Enter custom static IP (default: $CURRENT_IP):"
read -p "Static IP: " STATIC_IP
STATIC_IP="${STATIC_IP:-$CURRENT_IP}"

# Ensure the IP has the CIDR notation
if [[ ! "$STATIC_IP" =~ /.*/ ]]; then
  STATIC_IP="$STATIC_IP/24"
fi

echo "Enter custom Gateway (default: $CURRENT_GATEWAY):"
read -p "Gateway: " STATIC_GATEWAY
STATIC_GATEWAY="${STATIC_GATEWAY:-$CURRENT_GATEWAY}"

echo "Enter custom DNS (default: $CURRENT_DNS):"
read -p "DNS: " STATIC_DNS
STATIC_DNS="${STATIC_DNS:-$CURRENT_DNS}"

# Show the final selected configuration
echo
echo "Applying the following static IP settings:"
echo "Static IP: $STATIC_IP"
echo "Gateway: $STATIC_GATEWAY"
echo "DNS: $STATIC_DNS"
echo

# Apply configuration based on detected network system
if [ "$NETWORK_SYSTEM" == "networkmanager" ]; then
  echo "Using NetworkManager (nmcli)..."
  
  # Fetch the active connection name using nmcli
  CONNECTION_NAME=$(nmcli device show "$INTERFACE_NAME" | grep 'GENERAL.CONNECTION' | awk -F': ' '{print $2}' | sed 's/^[ \t]*//;s/[ \t]*$//')
  
  # Check if the connection name is valid and active
  if [ -z "$CONNECTION_NAME" ]; then
    echo "Error: No active connection found for interface $INTERFACE_NAME."
    exit 1
  fi
  
  echo "Applying settings to connection: $CONNECTION_NAME"
  # Disable DHCP and apply static IP configuration using nmcli
  sudo nmcli con mod "$CONNECTION_NAME" ipv4.addresses "$STATIC_IP" ipv4.gateway "$STATIC_GATEWAY" ipv4.dns "$STATIC_DNS" ipv4.method manual
  
  # Restart the connection to apply the changes
  sudo nmcli con down "$CONNECTION_NAME" && sudo nmcli con up "$CONNECTION_NAME"
  
else
  echo "Using Netplan (systemd-networkd)..."
  
  # Find or create netplan config file
  NETPLAN_FILE="/etc/netplan/01-netcfg.yaml"
  
  # Backup existing netplan configs
  sudo cp -r /etc/netplan /etc/netplan.backup.$(date +%Y%m%d_%H%M%S)
  
  # Create new netplan configuration
  cat << EOF | sudo tee "$NETPLAN_FILE" > /dev/null
network:
  version: 2
  renderer: networkd
  ethernets:
    $INTERFACE_NAME:
      dhcp4: no
      addresses:
        - $STATIC_IP
      routes:
        - to: default
          via: $STATIC_GATEWAY
      nameservers:
        addresses:
          - $STATIC_DNS
EOF
  
  echo "Created netplan configuration at $NETPLAN_FILE"
  
  # Test the configuration
  echo "Testing netplan configuration..."
  if sudo netplan try --timeout 10; then
    echo "Configuration accepted and applied successfully!"
  else
    echo "Error: Netplan configuration test failed. Restoring backup..."
    sudo rm "$NETPLAN_FILE"
    exit 1
  fi
fi

echo
echo "Static IP configuration applied successfully for interface $INTERFACE_NAME!"
echo "New IP: $STATIC_IP"
echo "Gateway: $STATIC_GATEWAY"
echo "DNS: $STATIC_DNS"
