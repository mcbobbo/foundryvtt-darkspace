import CharacterGeneratorDS from "../apps/characterGeneratorDS.mjs";
import LevelUpDS from "../apps/levelUpDS.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

export default class SpacerSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

    constructor(object, options) {
        super(object, options);

        // Unlocks every derived/locked value on the sheet at once
        this.editing = false;
    }

    static DEFAULT_OPTIONS = {
        classes: ["darkspace", "spacer"],
        position: { width: 1000, height: 700 },
        window: { resizable: true },
        form: {
            handler: SpacerSheet.#onSubmit,
            submitOnChange: true,
        },
        actions: {
            "roll-ability-check": SpacerSheet.#onRollAbilityCheck,
            "item-attack":     SpacerSheet.#onItemAttack,
            "item-create":     SpacerSheet.#onItemCreate,
            "item-edit":       SpacerSheet.#onItemEdit,
            "edit-sheet":      SpacerSheet.#onEditSheet,
            "toggle-equipped": SpacerSheet.#onToggleEquipped,
            "toggle-stashed":  SpacerSheet.#onToggleStashed,
            "credits-to-ship": SpacerSheet.#onCreditsToShip,
            "ship-open":       SpacerSheet.#onShipOpen,
            "level-up":        SpacerSheet.#onLevelUp,
        },
    };

    static PARTS = {
        sidebar: { template: "modules/darkspace/templates/actors/spacer/sidebar.hbs" },
        tabs:    { template: "templates/generic/tab-navigation.hbs" },
        details: { template: "modules/darkspace/templates/actors/spacer/_partials/tab-details.hbs",  scrollable: [""] },
        gear:    { template: "modules/darkspace/templates/actors/spacer/_partials/tab-gear.hbs",     scrollable: [""] },
        talents: { template: "modules/darkspace/templates/actors/spacer/_partials/tab-talents.hbs",  scrollable: [""] },
        notes:   { template: "modules/darkspace/templates/actors/partials/tab-notes.hbs",             scrollable: [""] },
    };

    static TABS = {
        primary: {
            tabs: [{ id: "details" }, { id: "gear" }, { id: "talents" }, { id: "notes" }],
            initial: "details",
            labelPrefix: "DARKSPACE.sheet.spacer.tab",
        },
    };

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
        const actor   = this.actor;
        const system  = actor.system;

        context.actor        = actor;
        context.system       = system;
        context.owner        = actor.isOwner;
        context.abilities    = system.abilities;
        context.editing      = this.editing;
        context.maxHp        = system.attributes?.hp?.max ?? 0;

        // Shadowdark advancement: 10 XP per current level
        context.xpNextLevel = system.level.value * 10;
        context.levelUp     = system.level.xp >= context.xpNextLevel;

        // Item lists
        const items         = actor.items.contents;
        const physicalItems = system.getPhysicalItems(); // isPhysical && !stashed
        context.inventory = {
            equipped: physicalItems.filter(i => i.system.equipped),
            carried:  physicalItems.filter(i => !i.system.equipped),
            stashed:  system.getStashedItems(),
        };
        const talentItems = items.filter(i => i.type === "Talent");
        context.talents = {
            species:   talentItems.filter(i => i.system.talentClass === "ancestry"),
            archetype: talentItems.filter(i => i.system.talentClass === "class"),
            level:     talentItems.filter(i => !["ancestry", "class"].includes(i.system.talentClass)),
        };
        context.attacks          = await system.getAttacks();
        context.slots            = system.getSlotUsage();
        context.gearSlots        = system.slots;
        context.slotsOverCapacity = context.slots.total > context.gearSlots;

        // Species, archetype and background are embedded items
        context.archetype  = await system.getClass();
        context.species    = await system.getAncestry();
        context.background = await system.getBackground();

        context.shipRoles = [];
        if (system.shipUuid) {
            const ship       = await fromUuid(system.shipUuid).catch(() => null);
            context.shipName = ship?.name ?? "";
            context.shipId   = system.shipUuid;
            const roleUuids  = system.shipRoleUuids ?? [];
            if (ship) {
                context.shipRoles = ship.items
                    .filter(i => ["darkspace.ShipRole", "darkspace.Weapon"].includes(i.type)
                        && roleUuids.includes(i.uuid))
                    .map(i => i.type === "darkspace.Weapon"
                        ? game.i18n.format("DARKSPACE.sheet.ship.roles.gunner", { weapon: i.name })
                        : i.name);
            }
        }

        context.notesHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
            system.notes ?? "",
            { async: true, relativeTo: actor }
        );

        context.motivationChoices = [
            { value: "survivor", label: game.i18n.localize("DARKSPACE.motivation.survivor") },
            { value: "vile",     label: game.i18n.localize("DARKSPACE.motivation.vile") },
            { value: "virtuous", label: game.i18n.localize("DARKSPACE.motivation.virtuous") },
        ].map(m => ({ ...m, selected: system.motivation === m.value }));

        return context;
    }

    /** @override */
    _onFirstRender(context, options) {
        super._onFirstRender(context, options);

        // Gear and talent rows are edited and deleted from a right click menu.
        // Bound to the frame so it survives part re-renders.
        this._createContextMenu(this._getItemContextOptions, ".ds-item-row[data-item-id]", {
            fixed: true,
            hookName: "getItemContextOptions",
            parentClassHooks: false,
        });
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);

        if (!this.isEditable) return;

        // Name input — single line only; Enter commits instead of inserting a newline
        const nameInput = this.element.querySelector(".ds-name-input");
        if (nameInput) {
            nameInput.addEventListener("keydown", (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.currentTarget.blur();
            });
            // Strip line breaks from pasted text
            nameInput.addEventListener("input", (e) => {
                const el = e.currentTarget;
                if (/[\r\n]/.test(el.value)) el.value = el.value.replace(/[\r\n]+/g, " ");
            });
        }

        // Credits input — plain number sets, +/- prefix adjusts
        const creditsInput = this.element.querySelector(".ds-credits-input");
        if (creditsInput) {
            creditsInput.addEventListener("focus", (e) => {e.currentTarget.value = "";});
            creditsInput.addEventListener("blur", (e) => {e.currentTarget.value = e.currentTarget.dataset.value;});
            creditsInput.addEventListener("keyup", event => this.#onInputCredits(event));
        }
    }

    /** Lock width — only allow vertical resizing. */
    setPosition(position = {}) {
        if (position.width !== undefined) position.width = 1000;
        return super.setPosition(position);
    }

    // -----------------------------------------------
    // Context Menu
    // -----------------------------------------------

    /**
     * Right click options for an embedded item row.
     * @returns {ContextMenuEntry[]}
     * @protected
     */
    _getItemContextOptions() {
        return [
            {
                name: "DARKSPACE.sheet.contextMenu.edit",
                icon: "<i class=\"fa-solid fa-pen-to-square\"></i>",
                condition: () => this.actor.isOwner,
                callback: target => this.actor.items.get(target.dataset.itemId)?.sheet.render(true),
            },
            {
                name: "DARKSPACE.sheet.contextMenu.delete",
                icon: "<i class=\"fa-solid fa-trash\"></i>",
                condition: () => this.actor.isOwner,
                callback: target => this.actor.items.get(target.dataset.itemId)?.delete(),
            },
        ];
    }

    // -----------------------------------------------
    // Drag & Drop
    // -----------------------------------------------

    /** @override */
    async _onDropItem(event, item) {
        if (!this.actor.isOwner) return null;

        // Species, archetype and background replace any existing one
        if (item.type === "Ancestry")   return this.actor.system.addAncestry(item);
        if (item.type === "Class")      return this.actor.system.addClass(item);
        if (item.type === "Background") return this.actor.system.addBackground(item);

        return super._onDropItem(event, item);
    }

    // -----------------------------------------------
    // Action Handlers
    // -----------------------------------------------

    static async #onSubmit(event, form, formData) {
        await this.document.update(formData.object);
    }

    static #onEditSheet(event, target) {
        this.editing = !this.editing;
        this.render();
    }

    static async #onLevelUp(event, target) {
        const archetype = await this.actor.system.getClass();

        // A level 0 spacer without a real archetype is still being generated,
        // so it goes back to the generator rather than the level up app.
        if (this.actor.system.level.value === 0
            && (!archetype || archetype.name.includes("Level 0"))
        ) {
            new CharacterGeneratorDS(this.actor.id).render(true);
            return this.close();
        }

        // Hit points and talents are both rolled off the archetype.
        if (!archetype) {
            return ui.notifications.warn(
                game.i18n.localize("DARKSPACE.sheet.spacer.level.noArchetype")
            );
        }

        new LevelUpDS(this.actor.id).render(true);
    }

    static #onRollAbilityCheck(event, target) {
        const ability = target.dataset.ability;
        if (!ability) return;
        // skip roll prompt if shift clicked
        this.actor.system.rollStatCheck(ability, { skipPrompt: event.shiftKey });
    }

    static #onItemAttack(event, target) {
        const data = {
            skipPrompt: event.shiftKey, // skip roll prompt if shift clicked
        };
        const attackEl = target.closest("[data-item-uuid], [data-item-id]") ?? target;
        if (attackEl.dataset.attackType) {
            data.attack = { type: attackEl.dataset.attackType };
        }
        const itemUuid = attackEl.dataset.itemUuid
            ?? this.actor.items.get(attackEl.dataset.itemId)?.uuid;
        if (itemUuid) this.actor.system.rollAttack(itemUuid, data);
    }

    static #onItemCreate(event, target) {
        const types = target.dataset.itemTypes?.split(",")
            ?? ["Armor", "Basic", "Gem", "Potion", "Scroll", "Wand", "Weapon"];
        Item.createDialog(
            { type: target.dataset.itemType },
            { parent: this.actor },
            { types }
        );
    }

    static #onItemEdit(event, target) {
        this.actor.items.get(target.dataset.itemId)?.sheet.render(true);
    }

    static async #onShipOpen(event, target) {
        const ship = await fromUuid(target.dataset.uuid).catch(() => null);
        ship?.sheet.render(true);
    }

    static async #onToggleEquipped(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        await item?.update({ "system.equipped": !item.system.equipped, "system.stashed": false });
    }

    static async #onToggleStashed(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        await item?.update({ "system.stashed": !item.system.stashed, "system.equipped": false });
    }

    static async #onCreditsToShip(event, target) {
        const credits = await foundry.applications.api.DialogV2.prompt({
            window: { title: "DARKSPACE.sheet.spacer.credits.sendTitle" },
            content: `
                <div class="form-group">
                    <label>${game.i18n.localize("DARKSPACE.sheet.spacer.credits.sendLabel")}</label>
                    <input type="number" name="credits" min="1" step="1" autofocus />
                </div>`,
            ok: {
                label: "DARKSPACE.sheet.spacer.credits.sendButton",
                icon: "fa-solid fa-shuttle-space",
                callback: (event, button) => button.form.elements.credits.valueAsNumber,
            },
        });
        if (credits) await this.actor.system.creditsToShip(credits);
    }

    // -----------------------------------------------
    // Instance handler (change event, needs closure)
    // -----------------------------------------------

    async #onInputCredits(event) {
        if (event.keyCode !== 13) return;
        await this.actor.system.adjustCredits(event.currentTarget.value);
    }
}
