import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { BlockList, isIP } from 'node:net'

/** IPv4 addresses that are not on the public internet: this machine, private and shared networks, link-local, reserved. */
const NON_PUBLIC_V4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) NON_PUBLIC_V4.addSubnet(network, prefix, 'ipv4')

/**
 * IPv6 is checked against an allowlist, so an unlisted special range is never taken as public:
 * only global unicast (2000::/3) and the well-known NAT64 prefix (64:ff9b::/96, how IPv6-only
 * networks reach public IPv4 hosts) can be public; everything else (loopback, unique-local,
 * link-local, site-local, multicast, IPv4-mapped, 64:ff9b:1::/48, 5f00::/16, …) is refused.
 */
const GLOBAL_V6 = new BlockList()
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6')
GLOBAL_V6.addSubnet('64:ff9b::', 96, 'ipv6')
/** Ranges inside 2000::/3 that are not globally reachable: IETF protocol assignments, 6to4, documentation. */
const NON_PUBLIC_V6 = new BlockList()
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, 'ipv6')
}

/** Whether `address` (an IP address) is a public internet address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NON_PUBLIC_V4.check(address, 'ipv4')
  // An IPv4-mapped address (::ffff:a.b.c.d) is matched only against IPv4 rules, so GLOBAL_V6 refuses it.
  return family === 6 && GLOBAL_V6.check(address, 'ipv6') && !NON_PUBLIC_V6.check(address, 'ipv6')
}

/** Raised when a host name resolves to an address that is not public. */
export class NonPublicAddressError extends Error {
  override readonly name = 'NonPublicAddressError'
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
type Resolve = (hostname: string, options: LookupOptions & { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void

/**
 * A `lookup` for HTTP requests that may only reach public hosts: the name is resolved once, every
 * address it resolves to must be public (one private address refuses the whole name), and the
 * connection uses exactly those checked addresses, so a later lookup cannot swap in another.
 */
export function publicLookup(resolve: Resolve = dnsLookup as unknown as Resolve) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, [])
      if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        return callback(new NonPublicAddressError(`${hostname} does not resolve to public addresses only`), [])
      }
      if (options.all === true) callback(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
}
