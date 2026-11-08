let stopSharingNow: (() => void) | null = null

export function registerLocationStop(stop: () => void) {
  stopSharingNow = stop
  return () => {
    if (stopSharingNow === stop) stopSharingNow = null
  }
}

export function stopSharing() {
  stopSharingNow?.()
}
