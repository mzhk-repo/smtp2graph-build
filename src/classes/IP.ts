import { BlockList, isIP } from 'net';

export function isIpInSubnet(address: string, cidr: string): boolean
{
    const parts = cidr.split('/');
    const family = isIP(parts[0]);
    if(parts.length !== 2 || !family || isIP(address) !== family || !/^\d{1,3}$/.test(parts[1])) return false;

    const prefix = Number(parts[1]);
    if(prefix > (family === 4 ? 32 : 128)) return false;

    const type = family === 4 ? 'ipv4' : 'ipv6';
    const list = new BlockList();
    list.addSubnet(parts[0], prefix, type);
    return list.check(address, type);
}
