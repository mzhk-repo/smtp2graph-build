import { expect } from 'chai';
import { generateKeyPairSync } from 'crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { INetworkModule } from '@azure/msal-node';

describe('MSAL client credential compatibility', ()=>{
    for(const credential of ['secret', 'certificate'] as const)
    {
        it(`obtains a token with a ${credential} through a custom network client`, async ()=>{
            let requestBody = '';
            const networkClient: INetworkModule = {
                sendGetRequestAsync: async ()=>{ throw new Error('Unexpected metadata request'); },
                sendPostRequestAsync: async (_url, options)=>{
                    requestBody = options?.body || '';
                    return {status: 200, headers: {}, body: {token_type: 'Bearer', expires_in: 3600, ext_expires_in: 3600, access_token: 'synthetic-token'} as any};
                },
            };
            const privateKey = credential === 'certificate'
                ? generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}}).privateKey
                : undefined;
            const client = new ConfidentialClientApplication({
                auth: {
                    clientId: '11111111-1111-1111-1111-111111111111',
                    authority: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222',
                    clientSecret: credential === 'secret' ? 'synthetic-secret' : undefined,
                    clientCertificate: privateKey ? {thumbprint: '0123456789abcdef0123456789abcdef01234567', privateKey} : undefined,
                },
                system: {networkClient},
            });

            const result = await client.acquireTokenByClientCredential({scopes: ['https://graph.microsoft.com/.default']});
            const params = new URLSearchParams(requestBody);
            expect(result?.accessToken).to.equal('synthetic-token');
            expect(params.get('grant_type')).to.equal('client_credentials');
            if(credential === 'secret') expect(params.get('client_secret')).to.equal('synthetic-secret');
            else expect(params.get('client_assertion')?.split('.')).to.have.length(3);
        });
    }
});
