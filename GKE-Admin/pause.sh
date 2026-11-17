#!/bin/bash
set -euo pipefail

usage() {
	printf 'Usage: %s <p|r>\n' "$0" >&2
}

if [ "$#" -ne 1 ]; then
	usage
	exit 2
fi

case "$1" in
	"p")
		# Mise en pause (économies) : coupe l'orchestrateur et le proxy Guacamole sans état
		kubectl scale deployment rdp-orchestrator guac-proxy -n guacamole-system --replicas=0
		;;
	"r")
		# Reprise :
		kubectl scale deployment rdp-orchestrator -n guacamole-system --replicas=2
		kubectl scale deployment guac-proxy -n guacamole-system --replicas=3
		;;
	*)
		usage
		exit 2
		;;
esac
