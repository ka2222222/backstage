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
  BackendFeature,
  ExtensionPoint,
  coreServices,
  ServiceRef,
  ServiceFactory,
} from '@backstage/backend-plugin-api';
import { BackendLifecycleImpl } from '../services/implementations/rootLifecycle/rootLifecycleServiceFactory';
import { BackendPluginLifecycleImpl } from '../services/implementations/lifecycle/lifecycleServiceFactory';
import { EnumerableServiceHolder, ServiceOrExtensionPoint } from './types';
// Direct internal import to avoid duplication
// eslint-disable-next-line @backstage/no-forbidden-package-imports
import { InternalBackendFeature } from '@backstage/backend-plugin-api/src/wiring/types';
import { ForwardedError, ConflictError } from '@backstage/errors';
import { featureDiscoveryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { DependencyGraph } from '../lib/DependencyGraph';
import { ServiceRegistry } from './ServiceRegistry';

export interface BackendRegisterInit {
  consumes: Set<ServiceOrExtensionPoint>;
  provides: Set<ServiceOrExtensionPoint>;
  init: {
    deps: { [name: string]: ServiceOrExtensionPoint };
    func: (deps: { [name: string]: unknown }) => Promise<void>;
  };
}

export class BackendInitializer {
  #startPromise?: Promise<void>;
  #features = new Array<InternalBackendFeature>();
  #extensionPoints = new Map<string, { impl: unknown; pluginId: string }>();
  #serviceHolder: EnumerableServiceHolder | undefined;
  #providedServiceFactories = new Array<ServiceFactory>();
  #defaultApiFactories: ServiceFactory[];

  constructor(defaultApiFactories: ServiceFactory[]) {
    this.#defaultApiFactories = defaultApiFactories;
  }

  async #getInitDeps(
    deps: { [name: string]: ServiceOrExtensionPoint },
    pluginId: string,
  ) {
    const result = new Map<string, unknown>();
    const missingRefs = new Set<ServiceOrExtensionPoint>();

    for (const [name, ref] of Object.entries(deps)) {
      const ep = this.#extensionPoints.get(ref.id);
      if (ep) {
        if (ep.pluginId !== pluginId) {
          throw new Error(
            `Extension point registered for plugin '${ep.pluginId}' may not be used by module for plugin '${pluginId}'`,
          );
        }
        result.set(name, ep.impl);
      } else {
        const impl = await this.#serviceHolder!.get(
          ref as ServiceRef<unknown>,
          pluginId,
        );
        if (impl) {
          result.set(name, impl);
        } else {
          missingRefs.add(ref);
        }
      }
    }

    if (missingRefs.size > 0) {
      const missing = Array.from(missingRefs).join(', ');
      throw new Error(
        `No extension point or service available for the following ref(s): ${missing}`,
      );
    }

    return Object.fromEntries(result);
  }

  add(feature: BackendFeature) {
    if (this.#startPromise) {
      throw new Error('feature can not be added after the backend has started');
    }
    this.#addFeature(feature);
  }

  #addFeature(feature: BackendFeature) {
    if (feature.$$type !== '@backstage/BackendFeature') {
      throw new Error(
        `Failed to add feature, invalid type '${feature.$$type}'`,
      );
    }

    if (isServiceFactory(feature)) {
      if (feature.service.id === coreServices.pluginMetadata.id) {
        throw new Error(
          `The ${coreServices.pluginMetadata.id} service cannot be overridden`,
        );
      }
      if (
        this.#providedServiceFactories.find(
          sf => sf.service.id === feature.service.id,
        )
      ) {
        throw new Error(
          `Duplicate service implementations provided for ${feature.service.id}`,
        );
      }
      this.#providedServiceFactories.push(feature);
    } else if (isInternalBackendFeature(feature)) {
      if (feature.version !== 'v1') {
        throw new Error(
          `Failed to add feature, invalid version '${feature.version}'`,
        );
      }
      this.#features.push(feature);
    } else {
      throw new Error(
        `Failed to add feature, invalid feature ${JSON.stringify(feature)}`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.#startPromise) {
      throw new Error('Backend has already started');
    }

    const exitHandler = async () => {
      process.removeListener('SIGTERM', exitHandler);
      process.removeListener('SIGINT', exitHandler);
      process.removeListener('beforeExit', exitHandler);

      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    };

    process.addListener('SIGTERM', exitHandler);
    process.addListener('SIGINT', exitHandler);
    process.addListener('beforeExit', exitHandler);

    this.#startPromise = this.#doStart();
    await this.#startPromise;
  }

  async #doStart(): Promise<void> {
    this.#serviceHolder = ServiceRegistry.create([
      ...this.#defaultApiFactories,
      ...this.#providedServiceFactories,
    ]);

    const featureDiscovery = await this.#serviceHolder.get(
      featureDiscoveryServiceRef,
      'root',
    );

    if (featureDiscovery) {
      const { features } = await featureDiscovery.getBackendFeatures();
      for (const feature of features) {
        this.#addFeature(feature);
      }
    }

    // Initialize all root scoped services
    for (const ref of this.#serviceHolder.getServiceRefs()) {
      if (ref.scope === 'root') {
        await this.#serviceHolder.get(ref, 'root');
      }
    }

    const pluginInits = new Map<string, BackendRegisterInit>();
    const moduleInits = new Map<string, Map<string, BackendRegisterInit>>();

    // Enumerate all features
    for (const feature of this.#features) {
      for (const r of feature.getRegistrations()) {
        const provides = new Set<ExtensionPoint<unknown>>();

        if (r.type === 'plugin' || r.type === 'module') {
          for (const [extRef, extImpl] of r.extensionPoints) {
            if (this.#extensionPoints.has(extRef.id)) {
              throw new Error(
                `ExtensionPoint with ID '${extRef.id}' is already registered`,
              );
            }
            this.#extensionPoints.set(extRef.id, {
              impl: extImpl,
              pluginId: r.pluginId,
            });
            provides.add(extRef);
          }
        }

        if (r.type === 'plugin') {
          if (pluginInits.has(r.pluginId)) {
            throw new Error(`Plugin '${r.pluginId}' is already registered`);
          }
          pluginInits.set(r.pluginId, {
            provides,
            consumes: new Set(Object.values(r.init.deps)),
            init: r.init,
          });
        } else {
          let modules = moduleInits.get(r.pluginId);
          if (!modules) {
            modules = new Map();
            moduleInits.set(r.pluginId, modules);
          }
          if (modules.has(r.moduleId)) {
            throw new Error(
              `Module '${r.moduleId}' for plugin '${r.pluginId}' is already registered`,
            );
          }
          modules.set(r.moduleId, {
            provides,
            consumes: new Set(Object.values(r.init.deps)),
            init: r.init,
          });
        }
      }
    }

    const allPluginIds = [
      ...new Set([...pluginInits.keys(), ...moduleInits.keys()]),
    ];

    // All plugins are initialized in parallel
    await Promise.all(
      allPluginIds.map(async pluginId => {
        // Modules are initialized before plugins, so that they can provide extension to the plugin
        const modules = moduleInits.get(pluginId);
        if (modules) {
          const tree = DependencyGraph.fromIterable(
            Array.from(modules).map(([moduleId, moduleInit]) => ({
              value: { moduleId, moduleInit },
              // Relationships are reversed at this point since we're only interested in the extension points.
              // If a modules provides extension point A we want it to be initialized AFTER all modules
              // that depend on extension point A, so that they can provide their extensions.
              consumes: Array.from(moduleInit.provides).map(p => p.id),
              provides: Array.from(moduleInit.consumes).map(c => c.id),
            })),
          );
          const circular = tree.detectCircularDependency();
          if (circular) {
            throw new ConflictError(
              `Circular dependency detected for modules of plugin '${pluginId}', ${circular
                .map(({ moduleId }) => `'${moduleId}'`)
                .join(' -> ')}`,
            );
          }
          await tree.parallelTopologicalTraversal(
            async ({ moduleId, moduleInit }) => {
              const moduleDeps = await this.#getInitDeps(
                moduleInit.init.deps,
                pluginId,
              );
              await moduleInit.init.func(moduleDeps).catch(error => {
                throw new ForwardedError(
                  `Module '${moduleId}' for plugin '${pluginId}' startup failed`,
                  error,
                );
              });
            },
          );
        }

        // Once all modules have been initialized, we can initialize the plugin itself
        const pluginInit = pluginInits.get(pluginId);
        // We allow modules to be installed without the accompanying plugin, so the plugin may not exist
        if (pluginInit) {
          const pluginDeps = await this.#getInitDeps(
            pluginInit.init.deps,
            pluginId,
          );
          await pluginInit.init.func(pluginDeps).catch(error => {
            throw new ForwardedError(
              `Plugin '${pluginId}' startup failed`,
              error,
            );
          });
        }

        // Once the plugin and all modules have been initialized, we can signal that the plugin has stared up successfully
        const lifecycleService = await this.#getPluginLifecycleImpl(pluginId);
        await lifecycleService.startup();
      }),
    );

    // Once all plugins and modules have been initialized, we can signal that the backend has started up successfully
    const lifecycleService = await this.#getRootLifecycleImpl();
    await lifecycleService.startup();

    // Once the backend is started, any uncaught errors or unhandled rejections are caught
    // and logged, in order to avoid crashing the entire backend on local failures.
    if (process.env.NODE_ENV !== 'test') {
      const rootLogger = await this.#serviceHolder.get(
        coreServices.rootLogger,
        'root',
      );
      process.on('unhandledRejection', (reason: Error) => {
        rootLogger
          ?.child({ type: 'unhandledRejection' })
          ?.error('Unhandled rejection', reason);
      });
      process.on('uncaughtException', error => {
        rootLogger
          ?.child({ type: 'uncaughtException' })
          ?.error('Uncaught exception', error);
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.#startPromise) {
      return;
    }

    try {
      await this.#startPromise;
    } catch (error) {
      // The startup failed, but we may still want to do cleanup so we continue silently
    }

    const lifecycleService = await this.#getRootLifecycleImpl();
    await lifecycleService.shutdown();
  }

  // Bit of a hacky way to grab the lifecycle services, potentially find a nicer way to do this
  async #getRootLifecycleImpl(): Promise<BackendLifecycleImpl> {
    const lifecycleService = await this.#serviceHolder!.get(
      coreServices.rootLifecycle,
      'root',
    );
    if (lifecycleService instanceof BackendLifecycleImpl) {
      return lifecycleService;
    }
    throw new Error('Unexpected root lifecycle service implementation');
  }

  async #getPluginLifecycleImpl(
    pluginId: string,
  ): Promise<BackendPluginLifecycleImpl> {
    const lifecycleService = await this.#serviceHolder!.get(
      coreServices.lifecycle,
      pluginId,
    );
    if (lifecycleService instanceof BackendPluginLifecycleImpl) {
      return lifecycleService;
    }
    throw new Error('Unexpected plugin lifecycle service implementation');
  }
}

function isServiceFactory(feature: BackendFeature): feature is ServiceFactory {
  return !!(feature as ServiceFactory).service;
}

function isInternalBackendFeature(
  feature: BackendFeature,
): feature is InternalBackendFeature {
  return (
    typeof (feature as InternalBackendFeature).getRegistrations === 'function'
  );
}
