#!/usr/bin/env bash

prefix="[install-and-rulesync]"
heartbeat_seconds=10

log() {
	printf '%s %s\n' "$prefix" "$1"
}

elapsed_seconds() {
	local started_at="$1"
	local now
	now="$(date +%s)"
	printf '%s' "$((now - started_at))"
}

run_with_progress() {
	local label="$1"
	shift

	local started_at
	started_at="$(date +%s)"
	log "Starting ${label}..."

	"$@" &
	local command_pid=$!
	local next_heartbeat=$((started_at + heartbeat_seconds))

	while kill -0 "$command_pid" 2>/dev/null; do
		sleep 1
		local now
		now="$(date +%s)"
		if [ "$now" -ge "$next_heartbeat" ] && kill -0 "$command_pid" 2>/dev/null; then
			log "Still running ${label} ($(elapsed_seconds "$started_at")s elapsed)..."
			next_heartbeat=$((now + heartbeat_seconds))
		fi
	done

	wait "$command_pid"
	local status=$?
	if [ "$status" -eq 0 ]; then
		log "Finished ${label} in $(elapsed_seconds "$started_at")s."
	else
		log "Warning: ${label} exited with status ${status} after $(elapsed_seconds "$started_at")s."
	fi

	return "$status"
}

resolve_base_ref() {
	local hook_name="$1"

	if [ "$hook_name" = "post-rewrite" ]; then
		git rev-parse --verify ORIG_HEAD 2>/dev/null ||
			git rev-parse --verify 'HEAD@{1}' 2>/dev/null ||
			true
		return
	fi

	git rev-parse --verify ORIG_HEAD 2>/dev/null || true
}

main() {
	local hook_name="${1:-post-merge}"

	if [ -n "$CI" ]; then
		log "Skipping in CI."
		return 0
	fi

	if ! command -v pnpm >/dev/null; then
		log "Skipping because pnpm is not available."
		return 0
	fi

	local root
	root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
	cd "$root" || return 0

	log "Checking whether dependency manifests changed after ${hook_name}."

	local base_ref
	base_ref="$(resolve_base_ref "$hook_name")"

	if [ -z "$base_ref" ]; then
		log "No previous ref found; skipping pnpm install."
	elif git diff --quiet "$base_ref" HEAD -- \
		':(glob)**/package.json' \
		':(glob)**/pnpm-lock.yaml' \
		':(glob)pnpm-workspace.yaml'; then
		log "Dependency manifests unchanged; skipping pnpm install."
	else
		log "Dependency manifests changed; pnpm install may take a while on large merges."
		run_with_progress "pnpm install" pnpm install || true
	fi

	log "Rulesync keeps generated agent files current when this repo has rulesync config."
	run_with_progress "pnpm rulesync" pnpm rulesync || true

	log "Codex plugin packages are generated from the Claude plugin sources."
	run_with_progress "pnpm import:codex" pnpm import:codex || true

	log "Done."
}

main "$@"
