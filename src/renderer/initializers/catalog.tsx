/**
 * Copyright (c) 2021 OpenLens Authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import React from "react";
import fs from "fs";
import path from "path";
import tempy from "tempy";
import "../../common/catalog-entities/kubernetes-cluster";
import { WebLinkCategory } from "../../common/catalog-entities";
import { ClusterId, ClusterStore } from "../../common/cluster-store";
import { appEventBus } from "../../common/event-bus";
import { catalogCategoryRegistry } from "../api/catalog-category-registry";
import { WeblinkAddCommand } from "../components/catalog-entities/weblink-add-command";
import { CommandOverlay } from "../components/command-palette";
import { Notifications } from "../components/notifications";
import { loadConfigFromString } from "../../common/kube-helpers";
import { ConfirmDialog } from "../components/confirm-dialog";
import { requestMain } from "../../common/ipc";
import { clusterClearDeletingHandler, clusterDeleteHandler, clusterSetDeletingHandler } from "../../common/cluster-ipc";
import { iter } from "../utils";
import { Select } from "../components/select";
import { HotbarStore } from "../../common/hotbar-store";

function initWebLinks() {
  WebLinkCategory.onAdd = () => CommandOverlay.open(<WeblinkAddCommand />);
}

function initKubernetesClusters() {
  catalogCategoryRegistry
    .getForGroupKind("entity.k8slens.dev", "KubernetesCluster")
    .on("contextMenuOpen", (entity, context) => {
      context.menuItems.push({
        title: "Delete",
        icon: "delete",
        onClick: () => deleteLocalCluster(entity.metadata.uid),
        confirm: {
          // TODO: change this to be a <p> tag with better formatting once this code can accept it.
          message: `Delete the "${entity.metadata.name}" context from "${entity.spec.kubeconfigPath}"?`
        }
      });
    });
}

export function initCatalog() {
  initWebLinks();
  initKubernetesClusters();
}

export async function deleteLocalCluster(clusterId: ClusterId): Promise<void> {
  appEventBus.emit({ name: "cluster", action: "remove" });
  const cluster = ClusterStore.getInstance().getById(clusterId);

  if (!cluster) {
    return console.warn("[KUBERNETES-CLUSTER]: cannot delete cluster, does not exist in store", { clusterId });
  }

  await requestMain(clusterSetDeletingHandler, clusterId);

  try {
    await fs.promises.access(cluster.kubeConfigPath, fs.constants.W_OK | fs.constants.R_OK);
  } catch {
    await requestMain(clusterClearDeletingHandler, clusterId);

    return void Notifications.error(
      <p>Cannot remove cluster, missing write permissions for <code>{cluster.kubeConfigPath}</code></p>
    );
  }

  const lockFilePath = `${path.resolve(cluster.kubeConfigPath)}.lock`;

  try {
    const fd = await fs.promises.open(lockFilePath, "wx");

    await fd.close(); // close immeditaly as we will want to delete the file later
  } catch (error) {
    await requestMain(clusterClearDeletingHandler, clusterId);
    console.warn("[KUBERNETES-CLUSTER]: failed to lock config file", error);

    switch (error.code) {
      case "EEXIST":
      case "EISDIR":
        return void Notifications.error("Cannot remove cluster, failed to aquire lock file. Already held.");
      case "EPERM":
      case "EACCES":
        return void Notifications.error("Cannot remove cluster, failed to aquire lock file. Permission denied.");
      default:
        return void Notifications.error(`Cannot remove cluster, failed to aquire lock file. ${error}`);
    }
  }

  try {
    const { config, error } = loadConfigFromString(await fs.promises.readFile(cluster.kubeConfigPath, "utf-8"));

    if (error) {
      throw error;
    }

    const contextNames = new Set(config.getContexts().map(({ name }) => name));

    contextNames.delete(cluster.contextName);

    if (config.currentContext === cluster.contextName && contextNames.size > 0) {
      const options = [
        {
          label: "--unset current-context--",
          value: false,
        },
        ...iter.map(contextNames, name => ({
          label: name,
          value: name,
        })),
      ];
      let selectedOption: string | false = false;
      const didConfirm = await ConfirmDialog.confirm({
        labelOk: "Select context",
        message: (
          <>
            <p>
              The context you are deleting is the <code>current-context</code> in the <code>{cluster.kubeConfigPath}</code> file.
              Please select one of the other contexts to replace it with.
            </p>
            <br />
            <Select
              options={options}
              onChange={({ value }) => selectedOption = value}
              themeName="light"
            />
          </>
        )
      });

      if (!didConfirm) {
        return void await requestMain(clusterClearDeletingHandler, clusterId);
      }

      if (selectedOption === false) {
        config.setCurrentContext(undefined);
      } else {
        config.setCurrentContext(selectedOption);
      }

    }

    config.contexts = config.contexts.filter(context => context.name !== cluster.contextName);

    const tmpFilePath = tempy.file();

    await fs.promises.writeFile(tmpFilePath, config.exportConfig());
    await fs.promises.rename(tmpFilePath, cluster.kubeConfigPath);
    await requestMain(clusterDeleteHandler, clusterId);
  } catch (error) {
    await requestMain(clusterClearDeletingHandler, clusterId);
    console.warn("[KUBERNETES-CLUSTER]: failed to read or parse kube config file", error);

    return void Notifications.error(`Cannot remove cluster, failed to process config file. ${error}`);
  } finally {
    await fs.promises.unlink(lockFilePath); // always unlink the file

    HotbarStore.getInstance().removeAllHotbarItems(clusterId);
  }
}
