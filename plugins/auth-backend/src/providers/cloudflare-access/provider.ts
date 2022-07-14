/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  AuthHandler,
  AuthProviderRouteHandlers,
  AuthResolverContext,
  AuthResponse,
  SignInResolver,
} from '../types';
import express from 'express';
import * as _ from 'lodash';
import fetch, { Headers, Response as FetchResponse } from 'node-fetch';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { Profile as PassportProfile } from 'passport';
import { AuthenticationError, ResponseError } from '@backstage/errors';
import { CacheClient } from '@backstage/backend-common';
import { createAuthProviderIntegration } from '../createAuthProviderIntegration';
import { prepareBackstageIdentityResponse } from '../prepareBackstageIdentityResponse';
import { makeProfileInfo } from '../../lib/passport';
import { commonByEmailResolver } from '../resolvers';
import { Logger } from 'winston';

// JWT Web Token definitions are in the URL below
// https://developers.cloudflare.com/cloudflare-one/identity/users/validating-json/
export const CF_JWT_HEADER = 'cf-access-jwt-assertion';
export const CF_AUTH_IDENTITY = 'cf-access-authenticated-user-email';
const COOKIE_AUTH_NAME = 'CF_Authorization';

/**
 * Default cache TTL
 *
 * @public
 */
export const CF_DEFAULT_CACHE_TTL = 3600;

/** @public */
export type Options = {
  /**
   * Access team name
   *
   * When you configure Access, the public certificates are available at this
   * URL, where your-team-name is your team name:
   * https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs
   */
  teamName: string;
  authHandler: AuthHandler<CloudflareAccessResult>;
  signInResolver: SignInResolver<CloudflareAccessResult>;
  resolverContext: AuthResolverContext;
  logger: Logger;
  cache?: CacheClient;
};

/** @public */
export type CloudflareAccessClaims = {
  /**
   * `aud` identifies the application to which the JWT is issued.
   */
  aud: string[];
  /**
   * `email` contains the email address of the authenticated user.
   */
  email: string;
  /**
   * iat and exp are the issuance and expiration timestamps.
   */
  exp: number;
  iat: number;
  /**
   * `nonce` is the session identifier.
   */
  nonce: string;
  /**
   * `identity_nonce` is available in the Application Token and can be used to
   * query all group membership for a given user.
   */
  identity_nonce: string;
  /**
   * `sub` contains the identifier of the authenticated user.
   */
  sub: string;
  /**
   * `iss` the issuer is the application’s Cloudflare Access Domain URL.
   */
  iss: string;
  /**
   * `custom` contains SAML attributes in the Application Token specified by an
   * administrator in the identity provider configuration.
   */
  custom: string;
};

type CloudflareAccessGroup = {
  id: string;
  name: string;
  email: string;
};

type CloudflareAccessIdentityProfile = {
  id: string;
  name: string;
  email: string;
  groups: CloudflareAccessGroup[];
};

export type CloudflareAccessResult = {
  fullProfile: PassportProfile;
  cfIdentity?: CloudflareAccessIdentityProfile;
  expiresInSeconds?: number;
};

/**
 * @public
 */
export type CloudflareAccessProviderInfo = {
  /**
   * Expiry of the access token in seconds.
   */
  expiresInSeconds?: number;
  /**
   * Cloudflare access identity profile with cloudflare access groups
   */
  cfAccessIdentityProfile?: CloudflareAccessIdentityProfile;
};

export type CloudflareAccessResponse =
  AuthResponse<CloudflareAccessProviderInfo>;

export class CloudflareAccessAuthProvider implements AuthProviderRouteHandlers {
  private readonly teamName: string;
  private readonly resolverContext: AuthResolverContext;
  private readonly authHandler: AuthHandler<CloudflareAccessResult>;
  private readonly signInResolver: SignInResolver<CloudflareAccessResult>;
  private readonly jwtKeySet: any;
  private readonly logger: Logger;
  private readonly cache?: CacheClient;

  constructor(options: Options) {
    this.teamName = options.teamName;
    this.authHandler = options.authHandler;
    this.signInResolver = options.signInResolver;
    this.resolverContext = options.resolverContext;
    this.jwtKeySet = createRemoteJWKSet(
      new URL(
        `https://${this.teamName}.cloudflareaccess.com/cdn-cgi/access/certs`,
      ),
    );
    this.logger = options.logger;
    this.cache = options.cache;
  }

  frameHandler(): Promise<void> {
    return Promise.resolve();
  }

  async refresh(req: express.Request, res: express.Response): Promise<void> {
    // ProxiedSignInPage calls `/refresh` implicitly each time the backstage
    // app is refreshed on the browser.
    // User authentication is then checked here.
    const result = await this.getResult(req);
    const response = await this.handleResult(result);
    res.json(response);
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  private async getIdentityProfile(
    jwt: string,
  ): Promise<CloudflareAccessIdentityProfile> {
    const headers = new Headers();
    // set both headers just the way inbound responses are set
    headers.set(CF_JWT_HEADER, jwt);
    headers.set('cookie', `${COOKIE_AUTH_NAME}=${jwt}`);
    try {
      const res: FetchResponse = await fetch(
        `https://${this.teamName}.cloudflareaccess.com/cdn-cgi/access/get-identity`,
        { headers },
      );
      if (!res.ok) {
        // Cast to work around https://github.com/backstage/backstage/issues/12166
        throw await ResponseError.fromResponse(res as unknown as Response);
      }
      const cfIdentity = await res.json();
      return cfIdentity as unknown as CloudflareAccessIdentityProfile;
    } catch (err) {
      this.logger.error(`getIdentityProfile failed: ${err}`);
      return Promise.reject(err);
    }
  }

  private async getResult(
    req: express.Request,
  ): Promise<CloudflareAccessResult> {
    // JWTs generated by Access are available in a request header as
    // Cf-Access-Jwt-Assertion and as cookies as CF_Authorization.
    let jwt = req.header(CF_JWT_HEADER);
    if (!jwt) {
      jwt = req.cookies.CF_Authorization;
    }
    if (!jwt) {
      // Only throw if both are not provided by Cloudflare Access since either
      // can be used.
      throw new AuthenticationError(
        `Missing ${CF_JWT_HEADER} from Cloudflare Access`,
      );
    }

    // Cloudflare signs the JWT using the RSA Signature with SHA-256 (RS256).
    // RS256 follows an asymmetric algorithm; a private key signs the JWTs and
    // a separate public key verifies the signature.
    const verifyResult = await jwtVerify(jwt, this.jwtKeySet, {
      issuer: `https://${this.teamName}.cloudflareaccess.com`,
    });
    const cfAccessResultStr = await this.cache?.get(jwt);
    if (typeof cfAccessResultStr === 'string') {
      return JSON.parse(cfAccessResultStr) as CloudflareAccessResult;
    }
    const claims = verifyResult.payload as CloudflareAccessClaims;
    // Builds a passport profile from JWT claims first
    const username = claims.email.split('@')[0].toLowerCase();
    const fullProfile: PassportProfile = {
      provider: 'cfAccess',
      id: claims.sub,
      displayName: _.startCase(username.replace('.', ' ')),
      username: username,
      emails: [{ value: claims.email }],
    };
    const cfAccessResult: CloudflareAccessResult = {
      fullProfile,
      expiresInSeconds: claims.exp - claims.iat,
    };
    try {
      // If we successfully fetch the get-identity endpoint,
      // We supplement the passport profile with richer user identity
      // information here.
      const cfIdentity = await this.getIdentityProfile(jwt);
      fullProfile.displayName = cfIdentity.name;
      fullProfile.emails = [{ value: cfIdentity.email }];
      fullProfile.username = cfIdentity.email.split('@')[0].toLowerCase();
      cfAccessResult.cfIdentity = cfIdentity;
      // Stores a stringified JSON object in cfaccess provider cache only when
      // we complete all steps
      this.cache?.set(jwt, JSON.stringify(cfAccessResult));
    } catch (err) {
      this.logger.error(
        `failed to populate access identity information: ${err}`,
      );
    }
    return cfAccessResult;
  }

  private async handleResult(
    result: CloudflareAccessResult,
  ): Promise<CloudflareAccessResponse> {
    const { profile } = await this.authHandler(result, this.resolverContext);
    const backstageIdentity = await this.signInResolver(
      {
        result,
        profile,
      },
      this.resolverContext,
    );

    return {
      providerInfo: {
        expiresInSeconds: result.expiresInSeconds,
        cfAccessIdentityProfile: result.cfIdentity,
      },
      backstageIdentity: prepareBackstageIdentityResponse(backstageIdentity),
      profile,
    };
  }
}

/**
 * Auth provider integration for Cloudflare Access auth
 *
 * @public
 */
export const cfAccess = createAuthProviderIntegration({
  create(options: {
    /**
     * The profile transformation function used to verify and convert the auth response
     * into the profile that will be presented to the user.
     */
    authHandler?: AuthHandler<CloudflareAccessResult>;

    /**
     * Configure sign-in for this provider, without it the provider can not be used to sign users in.
     */
    signIn: {
      /**
       * Maps an auth result to a Backstage identity for the user.
       */
      resolver: SignInResolver<CloudflareAccessResult>;
    };
    /**
     * CacheClient object that was configured for the Backstage backend,
     * should be provided via the backend auth plugin.
     */
    cache?: CacheClient;
  }) {
    return ({ config, logger, resolverContext }) => {
      const teamName = config.getString('teamName');

      if (!options.signIn.resolver) {
        throw new Error(
          'SignInResolver is required to use this authentication provider',
        );
      }

      const authHandler: AuthHandler<CloudflareAccessResult> =
        options?.authHandler
          ? options.authHandler
          : async ({ fullProfile }) => ({
              profile: makeProfileInfo(fullProfile),
            });

      return new CloudflareAccessAuthProvider({
        teamName,
        signInResolver: options?.signIn.resolver,
        authHandler,
        resolverContext,
        logger,
        ...(options.cache && { cache: options.cache }),
      });
    };
  },
  resolvers: {
    /**
     * Looks up the user by matching their email to the entity email.
     */
    emailMatchingUserEntityProfileEmail: () => commonByEmailResolver,
  },
});
