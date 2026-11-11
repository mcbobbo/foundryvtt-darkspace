import ShipLevelUpDS from "../apps/shipLevelUpDS.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

export default class ShipSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

    constructor(object, options) {
        super(object, options);

        // Unlocks every derived/locked value on the sheet at once
        this.editing = false;
    }

    static DEFAULT_OPTIONS = {
        classes: ["darkspace", "ship"],
        position: { width: 1100, height: 700 },
        form: {
            handler: ShipSheet.#onSubmit,
            submitOnChange: true,
        },
        actions: {
            "roll-ability-check": ShipSheet.#onRollAbilityCheck,
            "item-create":       ShipSheet.#onItemCreate,
            "item-edit":         ShipSheet.#onItemEdit,
            "item-delete":       ShipSheet.#onItemDelete,
            "crew-open":         ShipSheet.#onCrewOpen,
            "item-attack":       ShipSheet.#onItemAttack,
            "edit-sheet":        ShipSheet.#onEditSheet,
            "credits-to-crew":   ShipSheet.#onCreditsToCrew,
            "level-up":          ShipSheet.#onLevelUp,
        },
    };

    static PARTS = {
        sidebar: { template: "modules/darkspace/templates/actors/ship/sidebar.hbs" },
        tabs:    { template: "templates/generic/tab-navigation.hbs" },
        crew:    { template: "modules/darkspace/templates/actors/ship/_partials/tab-crew.hbs",    scrollable: [""] },
        systems: { template: "modules/darkspace/templates/actors/ship/_partials/tab-systems.hbs", scrollable: [""] },
        cargo:   { template: "modules/darkspace/templates/actors/ship/_partials/tab-cargo.hbs",   scrollable: [""] },
        notes:   { template: "modules/darkspace/templates/actors/partials/tab-notes.hbs",          scrollable: [""] },
    };

    static TABS = {
        primary: {
            tabs: [{ id: "crew" }, { id: "systems" }, { id: "cargo" }, { id: "notes" }],
            initial: "crew",
            labelPrefix: "DARKSPACE.sheet.ship.tab",
        },
    };

    #crewHooks = [];

    #isCrewChange(actor, changed = {}) {
        if (actor.type !== "darkspace.Spacer") return false;
        return actor.system.shipUuid === this.actor.uuid
            || foundry.utils.hasProperty(changed, "system.shipUuid");
    }

    /** @override */
    _onFirstRender(context, options) {
        super._onFirstRender(context, options);
        this.#crewHooks = [
            ["updateActor", Hooks.on("updateActor", (actor, changed) => {
                if (this.#isCrewChange(actor, changed)) this.render();
            })],
            ["deleteActor", Hooks.on("deleteActor", (actor) => {
                if (this.#isCrewChange(actor)) this.render();
            })],
        ];

        // Context menu for components, armor, talents, and cargo rows
        this._createContextMenu(this.#getShipItemContextOptions.bind(this), ".item[data-item-id]", {
            fixed: true,
            hookName: "getShipItemContextOptions",
            parentClassHooks: false,
        });
    }

    /** @override */
    _onClose(options) {
        super._onClose(options);
        for (const [hook, id] of this.#crewHooks) Hooks.off(hook, id);
        this.#crewHooks = [];
    }

    /** @override */
    _getHeaderControls() {
        const controls = super._getHeaderControls();
        controls.push({
            icon: "fa-solid fa-pen-to-square",
            label: "DARKSPACE.sheet.editSheet",
            action: "edit-sheet",
            ownership: "OWNER",
        });
        return controls;
    }

    /** @override */
    async _preparePartContext(partId, context, options) {
        await super._preparePartContext(partId, context, options);
        if (partId in context.tabs) context.tab = context.tabs[partId];
        return context;
    }

    /** @override */
    async _prepareContext(options) {
        const context = await super._prepareContext(options);

        context.actor = this.actor;
        const system = this.actor.system;
        context.system = system;
        context.owner = this.actor.isOwner;
        context.editing = this.editing;
        context.maxHp = system.attributes?.hp?.max ?? 0;
        context.crewLevel = system.getCrewLevel();
        context.levelUp = system.needsLevelUp;

        const items = this.actor.items;

        context.systems   = items.filter(i => i.type === "darkspace.ShipComponent" && i.system.type === "System");
        context.features  = items.filter(i => i.type === "darkspace.ShipComponent" && i.system.type === "Feature");
        context.armor     = items.filter(i => i.type === "darkspace.ShipArmor");
        context.weapons   = items.filter(i => i.type === "darkspace.Weapon");
        context.talents   = items.filter(i => i.type === "Talent");
        context.cargo     = system.getCargoItems();

        Object.assign(context, await this.#prepareCrewContext());

        context.shipClass       = await system.getShipClass();
        context.systemSlotsUsed = context.systems.reduce((sum, i) => sum + (i.system.slots ?? 1), 0);
        context.featureSlotsUsed = context.features.reduce((sum, i) => sum + (i.system.slots ?? 1), 0);
        context.systemSlotsMax  = context.shipClass?.system?.systemSlots ?? 0;
        context.featureSlotsMax = context.shipClass?.system?.featureSlots ?? 0;

        context.acProjectile = system.attributes?.ac?.projectile ?? 0;
        context.acEnergy     = system.attributes?.ac?.energy     ?? 0;

        context.notesHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
            system.notes ?? "",
            { async: true, relativeTo: this.actor }
        );
        return context;
    }

    async #prepareCrewContext() {
        const shipRoles  = this.actor.items.filter(i => i.type === "darkspace.ShipRole")
            .sort((a, b) => a.sort - b.sort);
        const crewActors = this.actor.system.getCrew();

        const crew = await Promise.all(crewActors.map(async (a) => {
            const archetypeObj  = await a.system?.getClass?.() ?? null;
            const backgroundObj = await a.system?.getBackground?.() ?? null;
            const roleUuids     = a.system?.shipRoleUuids ?? [];
            return {
                uuid:       a.uuid,
                name:       a.name ?? "Unknown",
                img:        a.img  ?? "icons/svg/mystery-man.svg",
                level:      a.system?.level?.value ?? 0,
                hp: {
                    value: a.system?.attributes?.hp?.value ?? 0,
                    max:   a.system?.attributes?.hp?.max   ?? 0,
                },
                archetype:  archetypeObj?.name  ?? "",
                background: backgroundObj?.name ?? "",
                roles:      shipRoles.filter(r => roleUuids.includes(r.uuid)).map(r => r.name),
            };
        }));

        const roles = shipRoles.map(role => {
            const holder = crewActors.find(a => (a.system?.shipRoleUuids ?? []).includes(role.uuid));
            return {
                roleUuid:   role.uuid,
                roleId:     role.id,
                roleName:   role.name,
                spacerUuid: holder?.uuid ?? "",
                spacerName: holder?.name ?? "",
            };
        });

        const gunnerRoles = this.actor.items.filter(i => i.type === "darkspace.Weapon")
            .sort((a, b) => a.sort - b.sort)
            .map(weapon => {
                const holder = crewActors.find(a => (a.system?.shipRoleUuids ?? []).includes(weapon.uuid));
                return {
                    roleUuid:   weapon.uuid,
                    roleName:   game.i18n.format("DARKSPACE.sheet.ship.roles.gunner", { weapon: weapon.name }),
                    spacerUuid: holder?.uuid ?? "",
                    spacerName: holder?.name ?? "",
                };
            });

        return { shipRoles, crew, roles, gunnerRoles };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);

        if (!this.isEditable) return;

        // Right-click menu on crew cards
        new foundry.applications.ux.ContextMenu.implementation(
            this.element,
            ".ds-crew-card",
            this.#getCrewContextOptions(),
            { jQuery: false }
        );

        // Right-click menu on role rows (gunner roles are derived from weapons, so no menu)
        new foundry.applications.ux.ContextMenu.implementation(
            this.element,
            ".ds-role-row:not(.ds-gunner-role)",
            this.#getRoleContextOptions(),
            { jQuery: false }
        );

        // Change events — AppV2 action system handles clicks only
        this.element.querySelectorAll("[data-action=role-spacer-change]").forEach(el => {
            el.addEventListener("change", event => this.#onRoleSpacerChange(event));
        });
        this.element.querySelectorAll("[data-action=toggle-online]").forEach(el => {
            el.addEventListener("change", event => {
                const item = this.actor.items.get(el.dataset.itemId);
                if (item) item.update({ "system.online": event.currentTarget.checked });
            });
        });
        this.element.querySelectorAll("[data-action=toggle-damaged]").forEach(el => {
            el.addEventListener("change", event => {
                const item = this.actor.items.get(el.dataset.itemId);
                if (item) item.update({ "system.damaged": event.currentTarget.checked });
            });
        });

        // Credits input — plain number sets, +/- prefix adjusts
        const creditsInput = this.element.querySelector(".ds-credits-input");
        if (creditsInput) {
            creditsInput.addEventListener("focus", (e) => {e.currentTarget.value = "";});
            creditsInput.addEventListener("blur", (e) => {e.currentTarget.value = e.currentTarget.dataset.value;});
            creditsInput.addEventListener("keyup", event => this.#onInputCredits(event));
        }
    }

    // -----------------------------------------------
    // Action Handlers (static, click events)
    // -----------------------------------------------

    static async #onSubmit(event, form, formData) {
        await this.document.update(formData.object);
    }

    static #onEditSheet(event, target) {
        this.editing = !this.editing;
        this.render();
    }

    static #onRollAbilityCheck(event, target) {
        const ability = target.dataset.ability;
        if (!ability) return;
        this.actor.system.rollStatCheck(ability, { skipPrompt: event.shiftKey });
    }

    static async #onItemCreate(event, target) {
        const itemType = target.dataset.itemType;
        const subtype  = target.dataset.componentSubtype;
        const label    = subtype ?? (itemType.includes(".") ? itemType.split(".")[1] : itemType);
        const itemData = {
            name:   `New ${label}`,
            type:   itemType,
            system: subtype ? { type: subtype } : {},
        };
        const [newItem] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
        newItem.sheet.render(true);
    }

    static #onItemEdit(event, target) {
        this.actor.items.get(target.dataset.itemId)?.sheet.render(true);
    }

    static async #onItemDelete(event, target) {
        const itemId = target.dataset.itemId;
        const item   = this.actor.items.get(itemId);
        if (!item) return;
        if (["darkspace.ShipRole", "darkspace.Weapon"].includes(item.type)) {
            await this.#unassignRoleFromCrew(item.uuid);
        }
        item.delete();
    }

    static async #onLevelUp(event, target) {
        const shipClass = await this.actor.system.getShipClass();
        if (!shipClass) {
            return ui.notifications.warn(game.i18n.localize("DARKSPACE.sheet.ship.level.noClass"));
        }
        new ShipLevelUpDS(this.actor.id).render(true);
    }

    static async #onCreditsToCrew(event, target) {
        const credits = await foundry.applications.api.DialogV2.prompt({
            window: { title: "DARKSPACE.sheet.ship.credits.sendTitle" },
            content: `
                <div class="form-group">
                    <label>${game.i18n.localize("DARKSPACE.sheet.ship.credits.sendLabel")}</label>
                    <input type="number" name="credits" min="1" step="1" autofocus />
                </div>`,
            ok: {
                label: "DARKSPACE.sheet.ship.credits.sendButton",
                icon: "fa-solid fa-people-group",
                callback: (event, button) => button.form.elements.credits.valueAsNumber,
            },
        });
        if (credits) await this.actor.system.creditsToCrew(credits);
    }

    // -----------------------------------------------
    // Context menus
    // -----------------------------------------------

    #getShipItemContextOptions() {
        return [
            {
                name: "DARKSPACE.sheet.contextMenu.edit",
                icon: '<i class="fa-solid fa-pen-to-square"></i>',
                condition: () => this.actor.isOwner,
                callback: element => this.actor.items.get(element.dataset.itemId)?.sheet.render(true),
            },
            {
                name: "DARKSPACE.sheet.contextMenu.delete",
                icon: '<i class="fa-solid fa-trash"></i>',
                condition: () => this.actor.isOwner,
                callback: async element => {
                    const item = this.actor.items.get(element.dataset.itemId);
                    if (!item) return;
                    if (["darkspace.ShipRole", "darkspace.Weapon"].includes(item.type)) {
                        await this.#unassignRoleFromCrew(item.uuid);
                    }
                    item.delete();
                },
            },
        ];
    }

    #getCrewContextOptions() {
        return [
            {
                name: "Remove from crew",
                icon: '<i class="fas fa-trash"></i>',
                callback: element => this.#removeCrew(element.dataset.uuid),
            },
        ];
    }

    #getRoleContextOptions() {
        return [
            {
                name: "Delete",
                icon: '<i class="fas fa-trash"></i>',
                callback: async element => {
                    const item = this.actor.items.get(element.dataset.itemId);
                    if (!item) return;
                    await this.#unassignRoleFromCrew(item.uuid);
                    item.delete();
                },
            },
        ];
    }

    async #removeCrew(uuid) {
        if (!uuid) return;
        const spacer = await fromUuid(uuid).catch(() => null);
        if (spacer) {
            await spacer.update({ "system.shipUuid": "", "system.shipRoleUuids": [] });
            this.render();
        }
    }

    static async #onCrewOpen(event, target) {
        const uuid   = target.closest("[data-uuid]")?.dataset.uuid;
        if (!uuid) return;
        const spacer = await fromUuid(uuid).catch(() => null);
        spacer?.sheet.render(true);
    }

    static #onItemAttack(event, target) {
        const data = {
            skipPrompt: event.shiftKey,
        };
        if (target.dataset.attackType) {
            data.attack = { type: target.dataset.attackType };
        }
        const item = this.actor.items.get(target.dataset.itemId);
        const itemUuid = target.dataset.itemUuid ?? item?.uuid;
        if (itemUuid) this.actor.system.rollAttack(itemUuid, data);
    }

    // -----------------------------------------------
    // Instance handlers
    // -----------------------------------------------

    async #onInputCredits(event) {
        if (event.keyCode !== 13) return;
        await this.actor.system.adjustCredits(event.currentTarget.value);
    }

    async #onRoleSpacerChange(event) {
        const roleUuid = event.currentTarget.dataset.roleUuid;
        const newUuid  = event.currentTarget.value;
        for (const spacer of this.actor.system.getCrew()) {
            const roleUuids = spacer.system.shipRoleUuids ?? [];
            const has       = roleUuids.includes(roleUuid);
            const should    = spacer.uuid === newUuid;
            if (has === should) continue;
            const next = should ? [...roleUuids, roleUuid] : roleUuids.filter(u => u !== roleUuid);
            await spacer.update({ "system.shipRoleUuids": next });
        }
        this.render();
    }

    async #unassignRoleFromCrew(roleUuid) {
        for (const spacer of this.actor.system.getCrew()) {
            const roleUuids = spacer.system.shipRoleUuids ?? [];
            if (roleUuids.includes(roleUuid)) {
                await spacer.update({ "system.shipRoleUuids": roleUuids.filter(u => u !== roleUuid) });
            }
        }
    }

    // -----------------------------------------------
    // Drag & Drop
    // -----------------------------------------------

    /** @override */
    async _onDropActor(event, actor) {
        if (!this.actor.isOwner) return null;
        if (actor?.type !== "darkspace.Spacer") return null;
        if (actor.system.shipUuid !== this.actor.uuid) {
            await actor.update({ "system.shipUuid": this.actor.uuid, "system.shipRoleUuids": [] });
            this.render();
        }
        return actor;
    }

    /** @override */
    async _onDropItem(event, item) {
        if (!this.actor.isOwner) return null;

        if (item.parent?.uuid === this.actor.uuid) return super._onDropItem(event, item);

        if (item.type === "darkspace.ShipClass") {
            const existing = this.actor.items.find(i => i.type === "darkspace.ShipClass");
            if (existing) {
                const confirmed = await foundry.applications.api.DialogV2.confirm({
                    window: { title: "DARKSPACE.sheet.ship.class.replaceTitle" },
                    content: `<p>${game.i18n.format("DARKSPACE.sheet.ship.class.replaceContent", {
                        current: existing.name,
                        new:     item.name,
                    })}</p>`,
                });
                if (!confirmed) return null;
                await existing.delete();
            }
            const [newItem] = await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
            await this.actor.update({ "system.class": newItem.uuid });
            return newItem;
        }

        if (["darkspace.ShipRole", "darkspace.ShipComponent", "darkspace.ShipArmor", "darkspace.Cargo"].includes(item.type)) {
            const [newItem] = await this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
            return newItem;
        }

        return super._onDropItem(event, item);
    }
}
