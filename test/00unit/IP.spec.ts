import { expect } from 'chai';
import { isIpInSubnet } from '../../src/classes/IP';

describe('IP subnet matching', ()=>{
    it('matches IPv4 and IPv6 addresses at subnet boundaries', ()=>{
        expect(isIpInSubnet('192.0.2.0', '192.0.2.0/24')).to.equal(true);
        expect(isIpInSubnet('192.0.2.255', '192.0.2.0/24')).to.equal(true);
        expect(isIpInSubnet('192.0.3.0', '192.0.2.0/24')).to.equal(false);
        expect(isIpInSubnet('2001:db8::1', '2001:db8::/32')).to.equal(true);
        expect(isIpInSubnet('2001:db9::1', '2001:db8::/32')).to.equal(false);
        expect(isIpInSubnet('192.0.2.1', '0.0.0.0/0')).to.equal(true);
        expect(isIpInSubnet('2001:db8::1', '::/0')).to.equal(true);
    });

    it('rejects different address families and invalid CIDR input', ()=>{
        expect(isIpInSubnet('192.0.2.1', '::/0')).to.equal(false);
        expect(isIpInSubnet('::ffff:192.0.2.1', '0.0.0.0/0')).to.equal(false);
        for(const cidr of ['192.0.2.0/33', '192.0.2.0/-1', '192.0.2.0/', '192.0.2.0/24/1', 'bad/24'])
            expect(isIpInSubnet('192.0.2.1', cidr), cidr).to.equal(false);
    });
});
