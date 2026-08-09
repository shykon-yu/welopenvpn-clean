export type DesktopLease = {
  host: string
  port: number
  username: string
  subnetCidr: string
  roomID: number
  token: string
}

export type DesktopLeaseStatus = {
  connected: boolean
  actualIp: string | null
  subnetCidr: string
  adapterName: string | null
  adapterDescription: string | null
  interfaceIndex: number | null
  interfaceMetric: number | null
  defaultGateways: string[]
  dnsServers: string[]
  macAddress: string | null
  conflictingAdapters: string[]
  conflictingAdapterIndexes: number[]
  warnings: string[]
  nicName?: string
}

export type DesktopStatus = {
  ready: boolean
  message: string
  openvpnInstalled: boolean
  tapName?: string
}

export type PingResult = {
  host: string
  reachable: boolean
  summary: string
}

declare global {
  interface Window {
    we8Desktop?: {
      connectVpn: (lease: DesktopLease) => Promise<DesktopLeaseStatus>
      restoreVpn: (lease: Pick<DesktopLease, 'username' | 'subnetCidr'>) => Promise<DesktopLeaseStatus>
      inspectVpn: (lease: Pick<DesktopLease, 'username' | 'subnetCidr'>) => Promise<DesktopLeaseStatus>
      desktopStatus: () => Promise<DesktopStatus>
      prepareDesktop: () => Promise<DesktopStatus>
      disconnectVpn: (username: string) => Promise<void>
      pingHost: (host: string) => Promise<PingResult>
      chooseGame: () => Promise<string | null>
      launchGame: (gamePath: string) => Promise<void>
    }
  }
}

export {}
