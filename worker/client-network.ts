// Canonicalize before grouping, including compressed and IPv4-mapped IPv6.
export function clientNetwork(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).map(Number).join('.') + '.0/24';
  try {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const parts = canonical.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const words = parts.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left;
    const nums = words.map(x => parseInt(x, 16));
    if (nums.slice(0,5).every(x => x === 0) && nums[5] === 65535)
      return `${nums[6] >> 8}.${nums[6] & 255}.${nums[7] >> 8}.0/24`;
    return nums.slice(0,4).map(x => x.toString(16)).join(':') + '::/64';
  } catch { return ip; }
}
