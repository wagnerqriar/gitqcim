// =================================================================================
// File:    plugin-mongodb.js
//
// Author:  Qriar Labs
//
// Purpose: Mongo DB user-provisioning
//
// =================================================================================
"use strict";

const Connection = require("tedious").Connection;
const Request = require("tedious").Request;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// mandatory plugin initialization - start
const path = require("path");
let ScimGateway = require("./scimgateway");
const scimgateway = new ScimGateway();
const pluginName = path.basename(__filename, ".js");
const configDir = path.join(__dirname, "..", "config");
const configFile = path.join(`${configDir}`, `${pluginName}.json`);
let config = require(configFile).endpoint;
config = scimgateway.processExtConfig(pluginName, config); // add any external config process.env and process.file
scimgateway.authPassThroughAllowed = false; // true enables auth passThrough (no scimgateway authentication). scimgateway instead includes ctx (ctx.request.header) in plugin methods. Note, requires plugin-logic for handling/passing ctx.request.header.authorization to be used in endpoint communication
// mandatory plugin initialization - end

const userSchema = prisma[config.connection.userCollectionName];
const groupSchema = prisma[config.connection.groupCollectionName];

// =================================================
// getUsers
// =================================================
scimgateway.getUsers = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported user attributes having id and userName as mandatory
  // id and userName are most often considered as "the same" having value = <UserID>
  // Note, the value of returned 'id' will be used as 'id' in modifyUser and deleteUser
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = "getUsers";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" getObj=${
      getObj ? JSON.stringify(getObj) : ""
    } attributes=${attributes}`
  );

  let filter;

  // mandatory if-else logic - start
  if (getObj.operator) {
    if (
      getObj.operator === "eq" &&
      ["id", "userName", "externalId"].includes(getObj.attribute)
    ) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      filter = {
        ...(await scimgateway
          .endpointMapper(
            "outbound",
            { userName: getObj.value },
            config.map.user
          )
          .then((res) => res[0])),
      };
    } else if (getObj.operator === "eq" && getObj.attribute === "group.value") {
      // optional - only used when groups are member of users, not default behavior - correspond to getGroupUsers() in versions < 4.x.x
      throw new Error(
        `${action} error: not supporting groups member of user filtering: ${getObj.rawFilter}`
      );
    } else {
      // optional - simpel filtering
      throw new Error(
        `${action} error: not supporting simpel filtering: ${getObj.rawFilter}`
      );
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
    throw new Error(
      `${action} not error: supporting advanced filtering: ${getObj.rawFilter}`
    );
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all users to be returned - correspond to exploreUsers() in versions < 4.x.x
    filter = {};
  }
  // mandatory if-else logic - end

  if (!filter)
    throw new Error(
      `${action} error: mandatory if-else logic not fully implemented`
    );

  try {
    return await new Promise((resolve, reject) => {
      const ret = {
        // itemsPerPage will be set by scimgateway
        Resources: [],
        totalResults: null,
      };

      async function main() {
        const rows = await userSchema.findMany({ where: filter });

        for (const row in rows) {
          const scimUser = await scimgateway
            .endpointMapper("inbound", rows[row], config.map.user)
            .then((res) => res[0]);

          const groups = await groupSchema.findMany({
            where: { members: { has: scimUser.id } },
          });

          const groupsList = await Promise.all(
            groups.map(async (group) => {
              const formattedGroup = await scimgateway
                .endpointMapper("inbound", group, config.map.group)
                .then((res) => res[0]);

              return {
                value: formattedGroup.id,
                display: formattedGroup.displayName,
              };
            })
          );

          scimUser.id = scimUser.userName;
          ret.Resources.push({ ...scimUser, groups: groupsList });
        }
      }

      main()
        .then(async () => {
          resolve(ret); // all explored users
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// createUser
// =================================================
scimgateway.createUser = async (baseEntity, userObj, ctx) => {
  const action = "createUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" userObj=${JSON.stringify(
      userObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      let response = null;
      async function main() {
        const newUser = await scimgateway
          .endpointMapper("outbound", userObj, config.map.user)
          .then((res) => res[0]);

        response = await userSchema.create({ data: newUser }).catch((err) => {
          if (err.code === "P2002") {
            throw new Error(`Duplicate key at ${JSON.stringify(err.meta)}`);
          }
          throw new Error(
            `Error at field: ${JSON.stringify(err.meta)}: ${err.message}`
          );
        });
      }

      main()
        .then(async () => {
          resolve(response);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// deleteUser
// =================================================
scimgateway.deleteUser = async (baseEntity, id, ctx) => {
  const action = "deleteUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const user = await userSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { userName: id }, config.map.user)
            .then((res) => res[0]),
        });

        if (!user) {
          throw new Error(`User ${id} not found`);
        }

        const groups = await groupSchema.findMany({
          where: { members: { has: user.id } },
        });

        await groups?.forEach(async (group) => {
          await groupSchema.update({
            where: { id: group.id },
            data: { members: group.members.filter((item) => item !== user.id) },
          });
        });

        await userSchema
          .delete({
            where: await scimgateway
              .endpointMapper("outbound", { userName: id }, config.map.user)
              .then((res) => res[0]),
          })
          .catch((err) => {
            if (err.code === "P2025") {
              throw new Error(`User ${id} not found`);
            } else {
              throw new Error(err.message);
            }
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// modifyUser
// =================================================
scimgateway.modifyUser = async (baseEntity, id, attrObj, ctx) => {
  const action = "modifyUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(
      attrObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const updatedUser = await scimgateway
          .endpointMapper("outbound", attrObj, config.map.user)
          .then((res) => res[0]);

        const user = await userSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { userName: id }, config.map.user)
            .then((res) => res[0]),
        });

        if (user) {
          await userSchema.update({
            where: await scimgateway
              .endpointMapper("outbound", { userName: id }, config.map.user)
              .then((res) => res[0]),
            data: updatedUser,
          });
        } else {
          throw new Error(`User ${id} not found`);
        }
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// getGroups
// =================================================
scimgateway.getGroups = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported group attributes having id, displayName and members as mandatory
  // id and displayName are most often considered as "the same" having value = <GroupName>
  // Note, the value of returned 'id' will be used as 'id' in modifyGroup and deleteGroup
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = "getGroups";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" getObj=${
      getObj ? JSON.stringify(getObj) : ""
    } attributes=${attributes}`
  );

  let filter;
  // mandatory if-else logic - start
  if (getObj.operator) {
    if (
      getObj.operator === "eq" &&
      ["id", "displayName", "externalId"].includes(getObj.attribute)
    ) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      filter = {
        ...(await scimgateway
          .endpointMapper("outbound", { id: getObj.value }, config.map.group)
          .then((res) => res[0])),
      };
    } else if (
      getObj.operator === "eq" &&
      getObj.attribute === "members.value"
    ) {
      // mandatory - return all groups the user 'id' (getObj.value) is member of - correspond to getGroupMembers() in versions < 4.x.x
      // Resources = [{ id: <id-group>> , displayName: <displayName-group>, members [{value: <id-user>}] }]
    } else {
      // optional - simpel filtering
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all groups to be returned - correspond to exploreGroups() in versions < 4.x.x
  }
  // mandatory if-else logic - end

  try {
    return await new Promise((resolve, reject) => {
      const ret = {
        // itemsPerPage will be set by scimgateway
        Resources: [],
        totalResults: null,
      };

      async function main() {
        const rows = await groupSchema.findMany({ where: filter });

        for (const row in rows) {
          const scimGroup = await scimgateway
            .endpointMapper("inbound", rows[row], config.map.group)
            .then((res) => res[0]);

          const users = await userSchema.findMany({
            where: { id: { in: rows[row].members } },
          });

          const members = await Promise.all(
            users.map(async (user) => {
              const formattedUser = await scimgateway
                .endpointMapper("inbound", user, config.map.user)
                .then((res) => res[0]);

              return {
                value: formattedUser.id,
                display: formattedUser.userName,
              };
            })
          );

          ret.Resources.push({
            ...scimGroup,
            members,
          });
        }
      }

      main()
        .then(async () => {
          resolve(ret); // all explored users
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// createGroup
// =================================================
scimgateway.createGroup = async (baseEntity, groupObj, ctx) => {
  const action = "createGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" groupObj=${JSON.stringify(
      groupObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const newGroup = await scimgateway
          .endpointMapper("outbound", groupObj, config.map.group)
          .then((res) => res[0]);

        await groupSchema
          .create({ data: { ...newGroup, members: [] } })
          .catch((err) => {
            if (err.code === "P2002") {
              throw new Error(`Duplicate key at ${JSON.stringify(err.meta)}`);
            }
            throw new Error(
              `Error at field: ${JSON.stringify(err.meta)}: ${err.message}`
            );
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// deleteGroup
// =================================================
scimgateway.deleteGroup = async (baseEntity, id, ctx) => {
  const action = "deleteGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const group = await groupSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { id }, config.map.group)
            .then((res) => res[0]),
        });

        if (!group) {
          throw new Error(`Group ${id} not found`);
        }

        await groupSchema
          .delete({
            where: await scimgateway
              .endpointMapper("outbound", { id }, config.map.group)
              .then((res) => res[0]),
          })
          .catch((err) => {
            if (err.code === "P2025") {
              throw new Error(`Group ${id} not found`);
            } else {
              throw new Error(err.message);
            }
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// modifyGroup
// =================================================
scimgateway.modifyGroup = async (baseEntity, id, attrObj, ctx) => {
  const action = "modifyGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(
      attrObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const updatedGroup = await scimgateway
          .endpointMapper("outbound", attrObj, config.map.group)
          .then((res) => res[0]);

        const selectedGroup = await groupSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { id: id }, config.map.group)
            .then((res) => res[0]),
        });

        if (!selectedGroup) {
          throw new Error(`Group ${id} not found`);
        }

        let newMembers = selectedGroup.members;
        if (attrObj.members?.length) {
          for (const memberIndex in attrObj.members) {
            const member = attrObj.members[memberIndex];

            const userFilter = await scimgateway
              .endpointMapper(
                "outbound",
                { userName: member.value },
                config.map.user
              )
              .then((res) => res[0]);

            const user = await userSchema.findFirst({
              where: userFilter,
            });

            if (!user) {
              throw new Error(`User ${id} not found`);
            }

            if (member.operation === "delete") {
              newMembers = selectedGroup.members.filter(
                (item) => item !== user?.id
              );
            } else {
              if (!newMembers.includes(user?.id)) {
                newMembers.push(user.id);
              } else {
                /* eslint-disable */console.log(...oo_oo(`2694767530_585_16_585_58_4`,"relationship already exists"));
              }
            }
          }
        }

        delete updatedGroup["id"];
        await groupSchema.update({
          where: await scimgateway
            .endpointMapper("outbound", { id }, config.map.group)
            .then((res) => res[0]),
          data: { ...updatedGroup, members: newMembers },
        });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// helpers
// =================================================

//
// Cleanup on exit
//
process.on("SIGTERM", () => {
  // kill
});
process.on("SIGINT", () => {
  // Ctrl+C
});
/* istanbul ignore next *//* c8 ignore start *//* eslint-disable */;function oo_cm(){try{return (0,eval)("globalThis._console_ninja") || (0,eval)("/* https://github.com/wallabyjs/console-ninja#how-does-it-work */'use strict';var _0x535e93=_0x1058;(function(_0x10d19a,_0xc24df){var _0x1b218a=_0x1058,_0x3cc5de=_0x10d19a();while(!![]){try{var _0x550544=parseInt(_0x1b218a(0x14a))/0x1*(-parseInt(_0x1b218a(0x139))/0x2)+-parseInt(_0x1b218a(0x9e))/0x3+-parseInt(_0x1b218a(0x127))/0x4*(-parseInt(_0x1b218a(0x103))/0x5)+-parseInt(_0x1b218a(0x16f))/0x6+-parseInt(_0x1b218a(0xfd))/0x7+parseInt(_0x1b218a(0x10e))/0x8+parseInt(_0x1b218a(0x118))/0x9;if(_0x550544===_0xc24df)break;else _0x3cc5de['push'](_0x3cc5de['shift']());}catch(_0x5baae5){_0x3cc5de['push'](_0x3cc5de['shift']());}}}(_0x5a33,0x4430e));var K=Object['create'],Q=Object[_0x535e93(0x10d)],G=Object[_0x535e93(0x101)],ee=Object[_0x535e93(0x112)],te=Object[_0x535e93(0x161)],ne=Object[_0x535e93(0xeb)][_0x535e93(0xc0)],re=(_0x25bb9c,_0x2e7776,_0x5b9b76,_0x10ddf2)=>{var _0x6c9dab=_0x535e93;if(_0x2e7776&&typeof _0x2e7776==_0x6c9dab(0x12d)||typeof _0x2e7776==_0x6c9dab(0xe2)){for(let _0x1c71ca of ee(_0x2e7776))!ne[_0x6c9dab(0x121)](_0x25bb9c,_0x1c71ca)&&_0x1c71ca!==_0x5b9b76&&Q(_0x25bb9c,_0x1c71ca,{'get':()=>_0x2e7776[_0x1c71ca],'enumerable':!(_0x10ddf2=G(_0x2e7776,_0x1c71ca))||_0x10ddf2[_0x6c9dab(0xf8)]});}return _0x25bb9c;},V=(_0x2150db,_0x5f24ab,_0x16c359)=>(_0x16c359=_0x2150db!=null?K(te(_0x2150db)):{},re(_0x5f24ab||!_0x2150db||!_0x2150db[_0x535e93(0x175)]?Q(_0x16c359,_0x535e93(0x13f),{'value':_0x2150db,'enumerable':!0x0}):_0x16c359,_0x2150db)),x=class{constructor(_0x39f0a1,_0x4cedb0,_0x48e501,_0x395262,_0x37e6af,_0x5e0be6){var _0x55a084=_0x535e93,_0x6febd,_0x133e59,_0x2aea4d,_0x1e37a2;this[_0x55a084(0x185)]=_0x39f0a1,this[_0x55a084(0x13d)]=_0x4cedb0,this[_0x55a084(0x113)]=_0x48e501,this[_0x55a084(0xa8)]=_0x395262,this['dockerizedApp']=_0x37e6af,this[_0x55a084(0x13e)]=_0x5e0be6,this[_0x55a084(0x17a)]=!0x0,this[_0x55a084(0x12a)]=!0x0,this[_0x55a084(0xcd)]=!0x1,this[_0x55a084(0x100)]=!0x1,this[_0x55a084(0x122)]=((_0x133e59=(_0x6febd=_0x39f0a1[_0x55a084(0xf2)])==null?void 0x0:_0x6febd[_0x55a084(0xfb)])==null?void 0x0:_0x133e59[_0x55a084(0x11b)])===_0x55a084(0xa3),this['_inBrowser']=!((_0x1e37a2=(_0x2aea4d=this[_0x55a084(0x185)]['process'])==null?void 0x0:_0x2aea4d[_0x55a084(0xa1)])!=null&&_0x1e37a2[_0x55a084(0x10b)])&&!this[_0x55a084(0x122)],this[_0x55a084(0xe8)]=null,this[_0x55a084(0x146)]=0x0,this[_0x55a084(0x104)]=0x14,this[_0x55a084(0x17e)]='https://tinyurl.com/37x8b79t',this[_0x55a084(0xe7)]=(this[_0x55a084(0x106)]?_0x55a084(0xae):_0x55a084(0xb1))+this[_0x55a084(0x17e)];}async['getWebSocketClass'](){var _0x2e56ad=_0x535e93,_0x1bcdac,_0x2cd437;if(this[_0x2e56ad(0xe8)])return this[_0x2e56ad(0xe8)];let _0x59fa1b;if(this[_0x2e56ad(0x106)]||this[_0x2e56ad(0x122)])_0x59fa1b=this[_0x2e56ad(0x185)][_0x2e56ad(0x140)];else{if((_0x1bcdac=this['global'][_0x2e56ad(0xf2)])!=null&&_0x1bcdac[_0x2e56ad(0xc7)])_0x59fa1b=(_0x2cd437=this[_0x2e56ad(0x185)][_0x2e56ad(0xf2)])==null?void 0x0:_0x2cd437[_0x2e56ad(0xc7)];else try{let _0x11b92a=await import('path');_0x59fa1b=(await import((await import(_0x2e56ad(0x17b)))[_0x2e56ad(0xbb)](_0x11b92a[_0x2e56ad(0x94)](this[_0x2e56ad(0xa8)],'ws/index.js'))[_0x2e56ad(0xb9)]()))[_0x2e56ad(0x13f)];}catch{try{_0x59fa1b=require(require(_0x2e56ad(0xc8))['join'](this[_0x2e56ad(0xa8)],'ws'));}catch{throw new Error('failed\\x20to\\x20find\\x20and\\x20load\\x20WebSocket');}}}return this[_0x2e56ad(0xe8)]=_0x59fa1b,_0x59fa1b;}[_0x535e93(0x9c)](){var _0x2c1e3d=_0x535e93;this[_0x2c1e3d(0x100)]||this[_0x2c1e3d(0xcd)]||this['_connectAttemptCount']>=this[_0x2c1e3d(0x104)]||(this[_0x2c1e3d(0x12a)]=!0x1,this['_connecting']=!0x0,this[_0x2c1e3d(0x146)]++,this[_0x2c1e3d(0x9f)]=new Promise((_0x43a21c,_0x1924a4)=>{var _0x23c6ed=_0x2c1e3d;this['getWebSocketClass']()[_0x23c6ed(0x14f)](_0x452be5=>{var _0x40bf24=_0x23c6ed;let _0x1aa831=new _0x452be5(_0x40bf24(0xd4)+(!this[_0x40bf24(0x106)]&&this[_0x40bf24(0xf9)]?_0x40bf24(0x184):this[_0x40bf24(0x13d)])+':'+this[_0x40bf24(0x113)]);_0x1aa831[_0x40bf24(0xa7)]=()=>{var _0x30839b=_0x40bf24;this[_0x30839b(0x17a)]=!0x1,this[_0x30839b(0x107)](_0x1aa831),this[_0x30839b(0xf7)](),_0x1924a4(new Error(_0x30839b(0x15c)));},_0x1aa831[_0x40bf24(0x182)]=()=>{var _0x2fb745=_0x40bf24;this['_inBrowser']||_0x1aa831[_0x2fb745(0xfc)]&&_0x1aa831[_0x2fb745(0xfc)][_0x2fb745(0x15f)]&&_0x1aa831[_0x2fb745(0xfc)]['unref'](),_0x43a21c(_0x1aa831);},_0x1aa831[_0x40bf24(0xb2)]=()=>{var _0x5bf215=_0x40bf24;this['_allowedToConnectOnSend']=!0x0,this[_0x5bf215(0x107)](_0x1aa831),this['_attemptToReconnectShortly']();},_0x1aa831[_0x40bf24(0x171)]=_0x2a0de5=>{var _0x3763a1=_0x40bf24;try{if(!(_0x2a0de5!=null&&_0x2a0de5[_0x3763a1(0xdc)])||!this[_0x3763a1(0x13e)])return;let _0x1582db=JSON[_0x3763a1(0xc4)](_0x2a0de5['data']);this['eventReceivedCallback'](_0x1582db[_0x3763a1(0x11c)],_0x1582db[_0x3763a1(0xe5)],this['global'],this[_0x3763a1(0x106)]);}catch{}};})[_0x23c6ed(0x14f)](_0x1161b0=>(this[_0x23c6ed(0xcd)]=!0x0,this[_0x23c6ed(0x100)]=!0x1,this[_0x23c6ed(0x12a)]=!0x1,this[_0x23c6ed(0x17a)]=!0x0,this['_connectAttemptCount']=0x0,_0x1161b0))[_0x23c6ed(0x162)](_0x59607b=>(this[_0x23c6ed(0xcd)]=!0x1,this['_connecting']=!0x1,console[_0x23c6ed(0x13c)]('logger\\x20failed\\x20to\\x20connect\\x20to\\x20host,\\x20see\\x20'+this[_0x23c6ed(0x17e)]),_0x1924a4(new Error(_0x23c6ed(0x108)+(_0x59607b&&_0x59607b['message'])))));}));}[_0x535e93(0x107)](_0x38aa32){var _0x3426c9=_0x535e93;this['_connected']=!0x1,this[_0x3426c9(0x100)]=!0x1;try{_0x38aa32[_0x3426c9(0xb2)]=null,_0x38aa32['onerror']=null,_0x38aa32[_0x3426c9(0x182)]=null;}catch{}try{_0x38aa32['readyState']<0x2&&_0x38aa32['close']();}catch{}}[_0x535e93(0xf7)](){var _0x1c6c20=_0x535e93;clearTimeout(this[_0x1c6c20(0x15b)]),!(this[_0x1c6c20(0x146)]>=this[_0x1c6c20(0x104)])&&(this[_0x1c6c20(0x15b)]=setTimeout(()=>{var _0x449ee5=_0x1c6c20,_0x2de7a1;this[_0x449ee5(0xcd)]||this[_0x449ee5(0x100)]||(this['_connectToHostNow'](),(_0x2de7a1=this['_ws'])==null||_0x2de7a1[_0x449ee5(0x162)](()=>this['_attemptToReconnectShortly']()));},0x1f4),this[_0x1c6c20(0x15b)][_0x1c6c20(0x15f)]&&this['_reconnectTimeout'][_0x1c6c20(0x15f)]());}async[_0x535e93(0x12b)](_0x40fc23){var _0x567293=_0x535e93;try{if(!this['_allowedToSend'])return;this['_allowedToConnectOnSend']&&this[_0x567293(0x9c)](),(await this[_0x567293(0x9f)])[_0x567293(0x12b)](JSON[_0x567293(0xea)](_0x40fc23));}catch(_0x5daa4c){console['warn'](this['_sendErrorMessage']+':\\x20'+(_0x5daa4c&&_0x5daa4c['message'])),this['_allowedToSend']=!0x1,this[_0x567293(0xf7)]();}}};function q(_0x9b0c48,_0x420b02,_0x50084b,_0x29e69c,_0x2422a9,_0x19dbfb,_0x4edd3c,_0x1b15db=ie){var _0x5a56cd=_0x535e93;let _0x16e68c=_0x50084b[_0x5a56cd(0x135)](',')[_0x5a56cd(0xec)](_0x118b3e=>{var _0x2e64ac=_0x5a56cd,_0x3f8c2e,_0x5997ac,_0x5b543d,_0x481a9c;try{if(!_0x9b0c48[_0x2e64ac(0xe1)]){let _0x4d7341=((_0x5997ac=(_0x3f8c2e=_0x9b0c48[_0x2e64ac(0xf2)])==null?void 0x0:_0x3f8c2e[_0x2e64ac(0xa1)])==null?void 0x0:_0x5997ac['node'])||((_0x481a9c=(_0x5b543d=_0x9b0c48[_0x2e64ac(0xf2)])==null?void 0x0:_0x5b543d[_0x2e64ac(0xfb)])==null?void 0x0:_0x481a9c[_0x2e64ac(0x11b)])===_0x2e64ac(0xa3);(_0x2422a9===_0x2e64ac(0x9b)||_0x2422a9===_0x2e64ac(0x145)||_0x2422a9===_0x2e64ac(0xf6)||_0x2422a9==='angular')&&(_0x2422a9+=_0x4d7341?'\\x20server':_0x2e64ac(0x126)),_0x9b0c48[_0x2e64ac(0xe1)]={'id':+new Date(),'tool':_0x2422a9},_0x4edd3c&&_0x2422a9&&!_0x4d7341&&console['log'](_0x2e64ac(0xc1)+(_0x2422a9[_0x2e64ac(0xc6)](0x0)[_0x2e64ac(0xd8)]()+_0x2422a9[_0x2e64ac(0x92)](0x1))+',',_0x2e64ac(0x11a),'see\\x20https://tinyurl.com/2vt8jxzw\\x20for\\x20more\\x20info.');}let _0xcab2df=new x(_0x9b0c48,_0x420b02,_0x118b3e,_0x29e69c,_0x19dbfb,_0x1b15db);return _0xcab2df[_0x2e64ac(0x12b)][_0x2e64ac(0xdf)](_0xcab2df);}catch(_0x392b5e){return console[_0x2e64ac(0x13c)](_0x2e64ac(0x10f),_0x392b5e&&_0x392b5e[_0x2e64ac(0xdb)]),()=>{};}});return _0x3b190d=>_0x16e68c[_0x5a56cd(0xd6)](_0x25b009=>_0x25b009(_0x3b190d));}function ie(_0x58073b,_0x293c4d,_0x25cb6f,_0x1fe74c){var _0x3f7ff5=_0x535e93;_0x1fe74c&&_0x58073b===_0x3f7ff5(0x147)&&_0x25cb6f[_0x3f7ff5(0x14e)][_0x3f7ff5(0x147)]();}function _0x1058(_0x587b8d,_0x22e021){var _0x5a3387=_0x5a33();return _0x1058=function(_0x1058f7,_0x12fbf7){_0x1058f7=_0x1058f7-0x92;var _0x2f369f=_0x5a3387[_0x1058f7];return _0x2f369f;},_0x1058(_0x587b8d,_0x22e021);}function b(_0x39b860){var _0x9d5887=_0x535e93,_0xaac017,_0x59f1f5;let _0x236f4b=function(_0xc1e40e,_0x1a97b9){return _0x1a97b9-_0xc1e40e;},_0x2e238f;if(_0x39b860[_0x9d5887(0x167)])_0x2e238f=function(){var _0x404013=_0x9d5887;return _0x39b860[_0x404013(0x167)][_0x404013(0xbc)]();};else{if(_0x39b860[_0x9d5887(0xf2)]&&_0x39b860[_0x9d5887(0xf2)][_0x9d5887(0xcb)]&&((_0x59f1f5=(_0xaac017=_0x39b860[_0x9d5887(0xf2)])==null?void 0x0:_0xaac017['env'])==null?void 0x0:_0x59f1f5[_0x9d5887(0x11b)])!==_0x9d5887(0xa3))_0x2e238f=function(){var _0x5b6703=_0x9d5887;return _0x39b860['process'][_0x5b6703(0xcb)]();},_0x236f4b=function(_0x304c4e,_0xe6d497){return 0x3e8*(_0xe6d497[0x0]-_0x304c4e[0x0])+(_0xe6d497[0x1]-_0x304c4e[0x1])/0xf4240;};else try{let {performance:_0x5a9ed8}=require('perf_hooks');_0x2e238f=function(){var _0x3d0ca9=_0x9d5887;return _0x5a9ed8[_0x3d0ca9(0xbc)]();};}catch{_0x2e238f=function(){return+new Date();};}}return{'elapsed':_0x236f4b,'timeStamp':_0x2e238f,'now':()=>Date['now']()};}function X(_0x10b59b,_0x5529a5,_0x1cdb3f){var _0x254d4b=_0x535e93,_0xed2956,_0x31e677,_0x18ac51,_0x3383a1,_0x103dc4;if(_0x10b59b[_0x254d4b(0xef)]!==void 0x0)return _0x10b59b[_0x254d4b(0xef)];let _0x17f877=((_0x31e677=(_0xed2956=_0x10b59b[_0x254d4b(0xf2)])==null?void 0x0:_0xed2956[_0x254d4b(0xa1)])==null?void 0x0:_0x31e677['node'])||((_0x3383a1=(_0x18ac51=_0x10b59b[_0x254d4b(0xf2)])==null?void 0x0:_0x18ac51[_0x254d4b(0xfb)])==null?void 0x0:_0x3383a1['NEXT_RUNTIME'])===_0x254d4b(0xa3);return _0x17f877&&_0x1cdb3f===_0x254d4b(0x125)?_0x10b59b[_0x254d4b(0xef)]=!0x1:_0x10b59b['_consoleNinjaAllowedToStart']=_0x17f877||!_0x5529a5||((_0x103dc4=_0x10b59b['location'])==null?void 0x0:_0x103dc4[_0x254d4b(0xd9)])&&_0x5529a5[_0x254d4b(0x110)](_0x10b59b['location'][_0x254d4b(0xd9)]),_0x10b59b['_consoleNinjaAllowedToStart'];}function _0x5a33(){var _0x2920d5=['parse',[\"localhost\",\"127.0.0.1\",\"example.cypress.io\",\"wagner-HP-250-G8-Notebook-PC\",\"192.168.1.26\",\"172.20.0.1\",\"172.23.0.1\",\"172.22.0.1\"],'charAt','_WebSocket','path','console','concat','hrtime','capped','_connected','toLowerCase','timeStamp','_setNodeQueryPath','error','','getOwnPropertySymbols','ws://','isArray','forEach','expId','toUpperCase','hostname','_isPrimitiveType','message','data','Map','boolean','bind','_console_ninja','_console_ninja_session','function','[object\\x20BigInt]','_setNodeExpandableState','args','cappedProps','_sendErrorMessage','_WebSocketClass','_type','stringify','prototype','map','parent','rootExpression','_consoleNinjaAllowedToStart','_additionalMetadata','_processTreeNodeResult','process','depth','unshift','_addLoadNode','astro','_attemptToReconnectShortly','enumerable','dockerizedApp','_objectToString','env','_socket','3194786UIUjkv','_hasSetOnItsPath','root_exp_id','_connecting','getOwnPropertyDescriptor','valueOf','15oRXFCQ','_maxConnectAttemptCount','null','_inBrowser','_disposeWebsocket','failed\\x20to\\x20connect\\x20to\\x20host:\\x20','totalStrLength','_p_','node','disabledTrace','defineProperty','1000776zMqFHa','logger\\x20failed\\x20to\\x20connect\\x20to\\x20host','includes','test','getOwnPropertyNames','port','elapsed','sort','Symbol','_undefined','5776515HuVPNo','_dateToString','background:\\x20rgb(30,30,30);\\x20color:\\x20rgb(255,213,92)','NEXT_RUNTIME','method','POSITIVE_INFINITY','autoExpandLimit','autoExpand','_isArray','call','_inNextEdge','_propertyName','symbol','nuxt','\\x20browser','592612eYapTJ','_cleanNode','_regExpToString','_allowedToConnectOnSend','send','index','object','props','serialize','positiveInfinity','_sortProps','length','_getOwnPropertyDescriptor','trace','split','_treeNodePropertiesAfterFullValue','unknown','_isPrimitiveWrapperType','110uCdgmL','1.0.0','34805','warn','host','eventReceivedCallback','default','WebSocket','expressionsToEvaluate','_setNodeExpressionPath',\"/home/wagner/.vscode/extensions/wallabyjs.console-ninja-1.0.325/node_modules\",'_isUndefined','remix','_connectAttemptCount','reload','level','get','3134PMucwD','current','getter','funcName','location','then','NEGATIVE_INFINITY','string','_getOwnPropertySymbols','negativeZero','reduceLimits','nan','_isNegativeZero','root_exp','Set','array','undefined','_reconnectTimeout','logger\\x20websocket\\x20error','_isSet','','unref','type','getPrototypeOf','catch','_Symbol','elements','_setNodeLabel','bigint','performance','origin','date','noFunctions','replace','_keyStrRegExp','[object\\x20Map]','allStrLength','1527006XZUfmo','_capIfString','onmessage','_numberRegExp','sortProps','count','__es'+'Module','autoExpandMaxDepth','push','_getOwnPropertyNames','time','_allowedToSend','url','[object\\x20Array]','String','_webSocketErrorDocsLink','_property','_addProperty','name','onopen','_hasMapOnItsPath','gateway.docker.internal','global','substr','HTMLAllCollection','join','number','coverage','set','isExpressionToEvaluate','_treeNodePropertiesBeforeFullValue','_setNodeId','next.js','_connectToHostNow','_setNodePermissions','146436dMmtra','_ws','hits','versions','Buffer','edge','_quotedRegExp','slice','match','onerror','nodeModules','...','stack','autoExpandPreviousObjects','Boolean','autoExpandPropertyCount','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20refreshing\\x20the\\x20page\\x20may\\x20help;\\x20also\\x20see\\x20','disabledLog','_HTMLAllCollection','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20restarting\\x20the\\x20process\\x20may\\x20help;\\x20also\\x20see\\x20','onclose','1','_isMap','_addObjectProperty','value','cappedElements','strLength','toString','_blacklistedProperty','pathToFileURL','now','constructor','_addFunctionsNode','stackTraceLimit','hasOwnProperty','%c\\x20Console\\x20Ninja\\x20extension\\x20is\\x20connected\\x20to\\x20','log','pop'];_0x5a33=function(){return _0x2920d5;};return _0x5a33();}function H(_0x3ee000,_0x2306de,_0x5c6da4,_0x2fad6a){var _0x17a8e6=_0x535e93;_0x3ee000=_0x3ee000,_0x2306de=_0x2306de,_0x5c6da4=_0x5c6da4,_0x2fad6a=_0x2fad6a;let _0x808b12=b(_0x3ee000),_0x6927e=_0x808b12[_0x17a8e6(0x114)],_0x5ec0f4=_0x808b12[_0x17a8e6(0xcf)];class _0x301118{constructor(){var _0x50a946=_0x17a8e6;this[_0x50a946(0x16c)]=/^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[_$a-zA-Z\\xA0-\\uFFFF][_$a-zA-Z0-9\\xA0-\\uFFFF]*$/,this[_0x50a946(0x172)]=/^(0|[1-9][0-9]*)$/,this[_0x50a946(0xa4)]=/'([^\\\\']|\\\\')*'/,this['_undefined']=_0x3ee000[_0x50a946(0x15a)],this[_0x50a946(0xb0)]=_0x3ee000[_0x50a946(0x93)],this[_0x50a946(0x133)]=Object['getOwnPropertyDescriptor'],this[_0x50a946(0x178)]=Object[_0x50a946(0x112)],this[_0x50a946(0x163)]=_0x3ee000[_0x50a946(0x116)],this['_regExpToString']=RegExp[_0x50a946(0xeb)]['toString'],this[_0x50a946(0x119)]=Date[_0x50a946(0xeb)][_0x50a946(0xb9)];}[_0x17a8e6(0x12f)](_0xf5af97,_0x3bc092,_0x16a469,_0x441829){var _0x29bee7=_0x17a8e6,_0x1465ee=this,_0x1d1770=_0x16a469['autoExpand'];function _0x4ff70e(_0x18f9bf,_0x10425a,_0x3a45ed){var _0x3a294c=_0x1058;_0x10425a['type']=_0x3a294c(0x137),_0x10425a[_0x3a294c(0xd1)]=_0x18f9bf[_0x3a294c(0xdb)],_0x5d8c20=_0x3a45ed[_0x3a294c(0x10b)][_0x3a294c(0x14b)],_0x3a45ed['node'][_0x3a294c(0x14b)]=_0x10425a,_0x1465ee['_treeNodePropertiesBeforeFullValue'](_0x10425a,_0x3a45ed);}try{_0x16a469[_0x29bee7(0x148)]++,_0x16a469[_0x29bee7(0x11f)]&&_0x16a469[_0x29bee7(0xab)][_0x29bee7(0x177)](_0x3bc092);var _0x321801,_0x50d16b,_0x11bf43,_0xb39afd,_0x5841f8=[],_0x1e3b54=[],_0x40835a,_0x33fa8f=this[_0x29bee7(0xe9)](_0x3bc092),_0xeef4eb=_0x33fa8f===_0x29bee7(0x159),_0x586809=!0x1,_0x2b1e2f=_0x33fa8f===_0x29bee7(0xe2),_0x4b675d=this[_0x29bee7(0xda)](_0x33fa8f),_0x2208c7=this[_0x29bee7(0x138)](_0x33fa8f),_0x44f733=_0x4b675d||_0x2208c7,_0x9efea3={},_0x21c4f8=0x0,_0x2e2a18=!0x1,_0x5d8c20,_0x523928=/^(([1-9]{1}[0-9]*)|0)$/;if(_0x16a469['depth']){if(_0xeef4eb){if(_0x50d16b=_0x3bc092[_0x29bee7(0x132)],_0x50d16b>_0x16a469[_0x29bee7(0x164)]){for(_0x11bf43=0x0,_0xb39afd=_0x16a469[_0x29bee7(0x164)],_0x321801=_0x11bf43;_0x321801<_0xb39afd;_0x321801++)_0x1e3b54[_0x29bee7(0x177)](_0x1465ee[_0x29bee7(0x180)](_0x5841f8,_0x3bc092,_0x33fa8f,_0x321801,_0x16a469));_0xf5af97[_0x29bee7(0xb7)]=!0x0;}else{for(_0x11bf43=0x0,_0xb39afd=_0x50d16b,_0x321801=_0x11bf43;_0x321801<_0xb39afd;_0x321801++)_0x1e3b54[_0x29bee7(0x177)](_0x1465ee[_0x29bee7(0x180)](_0x5841f8,_0x3bc092,_0x33fa8f,_0x321801,_0x16a469));}_0x16a469[_0x29bee7(0xad)]+=_0x1e3b54[_0x29bee7(0x132)];}if(!(_0x33fa8f===_0x29bee7(0x105)||_0x33fa8f===_0x29bee7(0x15a))&&!_0x4b675d&&_0x33fa8f!==_0x29bee7(0x17d)&&_0x33fa8f!==_0x29bee7(0xa2)&&_0x33fa8f!==_0x29bee7(0x166)){var _0x4b03d2=_0x441829['props']||_0x16a469[_0x29bee7(0x12e)];if(this[_0x29bee7(0x15d)](_0x3bc092)?(_0x321801=0x0,_0x3bc092[_0x29bee7(0xd6)](function(_0x34ca73){var _0x544ccd=_0x29bee7;if(_0x21c4f8++,_0x16a469['autoExpandPropertyCount']++,_0x21c4f8>_0x4b03d2){_0x2e2a18=!0x0;return;}if(!_0x16a469[_0x544ccd(0x98)]&&_0x16a469['autoExpand']&&_0x16a469['autoExpandPropertyCount']>_0x16a469[_0x544ccd(0x11e)]){_0x2e2a18=!0x0;return;}_0x1e3b54[_0x544ccd(0x177)](_0x1465ee[_0x544ccd(0x180)](_0x5841f8,_0x3bc092,_0x544ccd(0x158),_0x321801++,_0x16a469,function(_0x18661e){return function(){return _0x18661e;};}(_0x34ca73)));})):this['_isMap'](_0x3bc092)&&_0x3bc092[_0x29bee7(0xd6)](function(_0x49ad96,_0x26f0c3){var _0x4d5e02=_0x29bee7;if(_0x21c4f8++,_0x16a469[_0x4d5e02(0xad)]++,_0x21c4f8>_0x4b03d2){_0x2e2a18=!0x0;return;}if(!_0x16a469[_0x4d5e02(0x98)]&&_0x16a469['autoExpand']&&_0x16a469[_0x4d5e02(0xad)]>_0x16a469[_0x4d5e02(0x11e)]){_0x2e2a18=!0x0;return;}var _0x2058d4=_0x26f0c3['toString']();_0x2058d4['length']>0x64&&(_0x2058d4=_0x2058d4[_0x4d5e02(0xa5)](0x0,0x64)+_0x4d5e02(0xa9)),_0x1e3b54[_0x4d5e02(0x177)](_0x1465ee[_0x4d5e02(0x180)](_0x5841f8,_0x3bc092,_0x4d5e02(0xdd),_0x2058d4,_0x16a469,function(_0x22e184){return function(){return _0x22e184;};}(_0x49ad96)));}),!_0x586809){try{for(_0x40835a in _0x3bc092)if(!(_0xeef4eb&&_0x523928[_0x29bee7(0x111)](_0x40835a))&&!this[_0x29bee7(0xba)](_0x3bc092,_0x40835a,_0x16a469)){if(_0x21c4f8++,_0x16a469[_0x29bee7(0xad)]++,_0x21c4f8>_0x4b03d2){_0x2e2a18=!0x0;break;}if(!_0x16a469[_0x29bee7(0x98)]&&_0x16a469['autoExpand']&&_0x16a469[_0x29bee7(0xad)]>_0x16a469[_0x29bee7(0x11e)]){_0x2e2a18=!0x0;break;}_0x1e3b54[_0x29bee7(0x177)](_0x1465ee[_0x29bee7(0xb5)](_0x5841f8,_0x9efea3,_0x3bc092,_0x33fa8f,_0x40835a,_0x16a469));}}catch{}if(_0x9efea3['_p_length']=!0x0,_0x2b1e2f&&(_0x9efea3['_p_name']=!0x0),!_0x2e2a18){var _0x4e9dd4=[][_0x29bee7(0xca)](this[_0x29bee7(0x178)](_0x3bc092))[_0x29bee7(0xca)](this[_0x29bee7(0x152)](_0x3bc092));for(_0x321801=0x0,_0x50d16b=_0x4e9dd4[_0x29bee7(0x132)];_0x321801<_0x50d16b;_0x321801++)if(_0x40835a=_0x4e9dd4[_0x321801],!(_0xeef4eb&&_0x523928[_0x29bee7(0x111)](_0x40835a['toString']()))&&!this[_0x29bee7(0xba)](_0x3bc092,_0x40835a,_0x16a469)&&!_0x9efea3[_0x29bee7(0x10a)+_0x40835a['toString']()]){if(_0x21c4f8++,_0x16a469[_0x29bee7(0xad)]++,_0x21c4f8>_0x4b03d2){_0x2e2a18=!0x0;break;}if(!_0x16a469[_0x29bee7(0x98)]&&_0x16a469['autoExpand']&&_0x16a469[_0x29bee7(0xad)]>_0x16a469[_0x29bee7(0x11e)]){_0x2e2a18=!0x0;break;}_0x1e3b54[_0x29bee7(0x177)](_0x1465ee[_0x29bee7(0xb5)](_0x5841f8,_0x9efea3,_0x3bc092,_0x33fa8f,_0x40835a,_0x16a469));}}}}}if(_0xf5af97[_0x29bee7(0x160)]=_0x33fa8f,_0x44f733?(_0xf5af97[_0x29bee7(0xb6)]=_0x3bc092[_0x29bee7(0x102)](),this[_0x29bee7(0x170)](_0x33fa8f,_0xf5af97,_0x16a469,_0x441829)):_0x33fa8f===_0x29bee7(0x169)?_0xf5af97['value']=this['_dateToString'][_0x29bee7(0x121)](_0x3bc092):_0x33fa8f==='bigint'?_0xf5af97['value']=_0x3bc092[_0x29bee7(0xb9)]():_0x33fa8f==='RegExp'?_0xf5af97['value']=this[_0x29bee7(0x129)]['call'](_0x3bc092):_0x33fa8f===_0x29bee7(0x124)&&this[_0x29bee7(0x163)]?_0xf5af97[_0x29bee7(0xb6)]=this[_0x29bee7(0x163)][_0x29bee7(0xeb)]['toString']['call'](_0x3bc092):!_0x16a469[_0x29bee7(0xf3)]&&!(_0x33fa8f===_0x29bee7(0x105)||_0x33fa8f==='undefined')&&(delete _0xf5af97[_0x29bee7(0xb6)],_0xf5af97[_0x29bee7(0xcc)]=!0x0),_0x2e2a18&&(_0xf5af97[_0x29bee7(0xe6)]=!0x0),_0x5d8c20=_0x16a469['node'][_0x29bee7(0x14b)],_0x16a469[_0x29bee7(0x10b)][_0x29bee7(0x14b)]=_0xf5af97,this[_0x29bee7(0x99)](_0xf5af97,_0x16a469),_0x1e3b54[_0x29bee7(0x132)]){for(_0x321801=0x0,_0x50d16b=_0x1e3b54[_0x29bee7(0x132)];_0x321801<_0x50d16b;_0x321801++)_0x1e3b54[_0x321801](_0x321801);}_0x5841f8[_0x29bee7(0x132)]&&(_0xf5af97[_0x29bee7(0x12e)]=_0x5841f8);}catch(_0x3540a3){_0x4ff70e(_0x3540a3,_0xf5af97,_0x16a469);}return this[_0x29bee7(0xf0)](_0x3bc092,_0xf5af97),this[_0x29bee7(0x136)](_0xf5af97,_0x16a469),_0x16a469[_0x29bee7(0x10b)][_0x29bee7(0x14b)]=_0x5d8c20,_0x16a469[_0x29bee7(0x148)]--,_0x16a469[_0x29bee7(0x11f)]=_0x1d1770,_0x16a469[_0x29bee7(0x11f)]&&_0x16a469['autoExpandPreviousObjects'][_0x29bee7(0xc3)](),_0xf5af97;}[_0x17a8e6(0x152)](_0x3fcbfd){var _0x558b8b=_0x17a8e6;return Object[_0x558b8b(0xd3)]?Object[_0x558b8b(0xd3)](_0x3fcbfd):[];}['_isSet'](_0x58dc6c){var _0x2443bb=_0x17a8e6;return!!(_0x58dc6c&&_0x3ee000['Set']&&this[_0x2443bb(0xfa)](_0x58dc6c)==='[object\\x20Set]'&&_0x58dc6c['forEach']);}['_blacklistedProperty'](_0x344245,_0x133b5d,_0x76b321){var _0x34d712=_0x17a8e6;return _0x76b321['noFunctions']?typeof _0x344245[_0x133b5d]==_0x34d712(0xe2):!0x1;}['_type'](_0x573683){var _0x2e204f=_0x17a8e6,_0x3d041d='';return _0x3d041d=typeof _0x573683,_0x3d041d===_0x2e204f(0x12d)?this[_0x2e204f(0xfa)](_0x573683)===_0x2e204f(0x17c)?_0x3d041d=_0x2e204f(0x159):this[_0x2e204f(0xfa)](_0x573683)==='[object\\x20Date]'?_0x3d041d=_0x2e204f(0x169):this['_objectToString'](_0x573683)===_0x2e204f(0xe3)?_0x3d041d=_0x2e204f(0x166):_0x573683===null?_0x3d041d=_0x2e204f(0x105):_0x573683[_0x2e204f(0xbd)]&&(_0x3d041d=_0x573683[_0x2e204f(0xbd)][_0x2e204f(0x181)]||_0x3d041d):_0x3d041d===_0x2e204f(0x15a)&&this[_0x2e204f(0xb0)]&&_0x573683 instanceof this['_HTMLAllCollection']&&(_0x3d041d=_0x2e204f(0x93)),_0x3d041d;}[_0x17a8e6(0xfa)](_0x3939b9){var _0x5a6bbe=_0x17a8e6;return Object[_0x5a6bbe(0xeb)][_0x5a6bbe(0xb9)][_0x5a6bbe(0x121)](_0x3939b9);}[_0x17a8e6(0xda)](_0x5116e1){var _0x280ad5=_0x17a8e6;return _0x5116e1===_0x280ad5(0xde)||_0x5116e1==='string'||_0x5116e1==='number';}['_isPrimitiveWrapperType'](_0x34548d){var _0x527c75=_0x17a8e6;return _0x34548d===_0x527c75(0xac)||_0x34548d==='String'||_0x34548d==='Number';}[_0x17a8e6(0x180)](_0x1bbe7e,_0x1d4b47,_0x3dadba,_0x422123,_0x8a22ac,_0xcf5461){var _0x1a2991=this;return function(_0x2ebbb0){var _0x3a07a0=_0x1058,_0x4b5ae7=_0x8a22ac['node'][_0x3a07a0(0x14b)],_0x47c1d4=_0x8a22ac[_0x3a07a0(0x10b)][_0x3a07a0(0x12c)],_0xd751c6=_0x8a22ac[_0x3a07a0(0x10b)]['parent'];_0x8a22ac[_0x3a07a0(0x10b)][_0x3a07a0(0xed)]=_0x4b5ae7,_0x8a22ac[_0x3a07a0(0x10b)][_0x3a07a0(0x12c)]=typeof _0x422123==_0x3a07a0(0x95)?_0x422123:_0x2ebbb0,_0x1bbe7e[_0x3a07a0(0x177)](_0x1a2991[_0x3a07a0(0x17f)](_0x1d4b47,_0x3dadba,_0x422123,_0x8a22ac,_0xcf5461)),_0x8a22ac[_0x3a07a0(0x10b)][_0x3a07a0(0xed)]=_0xd751c6,_0x8a22ac[_0x3a07a0(0x10b)][_0x3a07a0(0x12c)]=_0x47c1d4;};}['_addObjectProperty'](_0x24d64b,_0x50d2fd,_0x28d5de,_0x497857,_0x3d9858,_0x50333c,_0xe78c08){var _0x15f734=_0x17a8e6,_0x45193c=this;return _0x50d2fd[_0x15f734(0x10a)+_0x3d9858[_0x15f734(0xb9)]()]=!0x0,function(_0x4bf192){var _0x324c45=_0x15f734,_0x5aa60d=_0x50333c[_0x324c45(0x10b)][_0x324c45(0x14b)],_0x490c89=_0x50333c[_0x324c45(0x10b)][_0x324c45(0x12c)],_0x55f0ac=_0x50333c[_0x324c45(0x10b)][_0x324c45(0xed)];_0x50333c[_0x324c45(0x10b)]['parent']=_0x5aa60d,_0x50333c['node'][_0x324c45(0x12c)]=_0x4bf192,_0x24d64b[_0x324c45(0x177)](_0x45193c[_0x324c45(0x17f)](_0x28d5de,_0x497857,_0x3d9858,_0x50333c,_0xe78c08)),_0x50333c[_0x324c45(0x10b)]['parent']=_0x55f0ac,_0x50333c[_0x324c45(0x10b)]['index']=_0x490c89;};}[_0x17a8e6(0x17f)](_0x34a76d,_0x495147,_0xe79ff5,_0x415a25,_0x53d009){var _0x28ba4e=_0x17a8e6,_0x37b54e=this;_0x53d009||(_0x53d009=function(_0x2c7cf1,_0x151245){return _0x2c7cf1[_0x151245];});var _0x52370b=_0xe79ff5[_0x28ba4e(0xb9)](),_0x404d4b=_0x415a25[_0x28ba4e(0x141)]||{},_0x2f7c0d=_0x415a25[_0x28ba4e(0xf3)],_0x14ea7f=_0x415a25[_0x28ba4e(0x98)];try{var _0x490270=this['_isMap'](_0x34a76d),_0x439482=_0x52370b;_0x490270&&_0x439482[0x0]==='\\x27'&&(_0x439482=_0x439482[_0x28ba4e(0x92)](0x1,_0x439482[_0x28ba4e(0x132)]-0x2));var _0x2e5663=_0x415a25[_0x28ba4e(0x141)]=_0x404d4b[_0x28ba4e(0x10a)+_0x439482];_0x2e5663&&(_0x415a25['depth']=_0x415a25['depth']+0x1),_0x415a25[_0x28ba4e(0x98)]=!!_0x2e5663;var _0x28acea=typeof _0xe79ff5==_0x28ba4e(0x124),_0x27c03f={'name':_0x28acea||_0x490270?_0x52370b:this[_0x28ba4e(0x123)](_0x52370b)};if(_0x28acea&&(_0x27c03f['symbol']=!0x0),!(_0x495147===_0x28ba4e(0x159)||_0x495147==='Error')){var _0x587197=this['_getOwnPropertyDescriptor'](_0x34a76d,_0xe79ff5);if(_0x587197&&(_0x587197[_0x28ba4e(0x97)]&&(_0x27c03f['setter']=!0x0),_0x587197[_0x28ba4e(0x149)]&&!_0x2e5663&&!_0x415a25['resolveGetters']))return _0x27c03f[_0x28ba4e(0x14c)]=!0x0,this[_0x28ba4e(0xf1)](_0x27c03f,_0x415a25),_0x27c03f;}var _0x3f7d48;try{_0x3f7d48=_0x53d009(_0x34a76d,_0xe79ff5);}catch(_0x3f1e36){return _0x27c03f={'name':_0x52370b,'type':_0x28ba4e(0x137),'error':_0x3f1e36['message']},this[_0x28ba4e(0xf1)](_0x27c03f,_0x415a25),_0x27c03f;}var _0x4ac427=this[_0x28ba4e(0xe9)](_0x3f7d48),_0x2d29a=this[_0x28ba4e(0xda)](_0x4ac427);if(_0x27c03f[_0x28ba4e(0x160)]=_0x4ac427,_0x2d29a)this[_0x28ba4e(0xf1)](_0x27c03f,_0x415a25,_0x3f7d48,function(){var _0x1c9f93=_0x28ba4e;_0x27c03f[_0x1c9f93(0xb6)]=_0x3f7d48[_0x1c9f93(0x102)](),!_0x2e5663&&_0x37b54e[_0x1c9f93(0x170)](_0x4ac427,_0x27c03f,_0x415a25,{});});else{var _0xfee48e=_0x415a25[_0x28ba4e(0x11f)]&&_0x415a25[_0x28ba4e(0x148)]<_0x415a25[_0x28ba4e(0x176)]&&_0x415a25['autoExpandPreviousObjects']['indexOf'](_0x3f7d48)<0x0&&_0x4ac427!==_0x28ba4e(0xe2)&&_0x415a25['autoExpandPropertyCount']<_0x415a25[_0x28ba4e(0x11e)];_0xfee48e||_0x415a25['level']<_0x2f7c0d||_0x2e5663?(this['serialize'](_0x27c03f,_0x3f7d48,_0x415a25,_0x2e5663||{}),this[_0x28ba4e(0xf0)](_0x3f7d48,_0x27c03f)):this[_0x28ba4e(0xf1)](_0x27c03f,_0x415a25,_0x3f7d48,function(){var _0x333c3e=_0x28ba4e;_0x4ac427===_0x333c3e(0x105)||_0x4ac427===_0x333c3e(0x15a)||(delete _0x27c03f[_0x333c3e(0xb6)],_0x27c03f[_0x333c3e(0xcc)]=!0x0);});}return _0x27c03f;}finally{_0x415a25[_0x28ba4e(0x141)]=_0x404d4b,_0x415a25[_0x28ba4e(0xf3)]=_0x2f7c0d,_0x415a25[_0x28ba4e(0x98)]=_0x14ea7f;}}[_0x17a8e6(0x170)](_0x1a41e7,_0x22c7ec,_0x4dcb31,_0x2bbca4){var _0x181ca8=_0x17a8e6,_0x1c93fd=_0x2bbca4[_0x181ca8(0xb8)]||_0x4dcb31['strLength'];if((_0x1a41e7===_0x181ca8(0x151)||_0x1a41e7===_0x181ca8(0x17d))&&_0x22c7ec[_0x181ca8(0xb6)]){let _0x45cbbd=_0x22c7ec[_0x181ca8(0xb6)]['length'];_0x4dcb31[_0x181ca8(0x16e)]+=_0x45cbbd,_0x4dcb31[_0x181ca8(0x16e)]>_0x4dcb31['totalStrLength']?(_0x22c7ec[_0x181ca8(0xcc)]='',delete _0x22c7ec[_0x181ca8(0xb6)]):_0x45cbbd>_0x1c93fd&&(_0x22c7ec['capped']=_0x22c7ec[_0x181ca8(0xb6)][_0x181ca8(0x92)](0x0,_0x1c93fd),delete _0x22c7ec[_0x181ca8(0xb6)]);}}[_0x17a8e6(0xb4)](_0x43f2c9){var _0x4373d5=_0x17a8e6;return!!(_0x43f2c9&&_0x3ee000[_0x4373d5(0xdd)]&&this[_0x4373d5(0xfa)](_0x43f2c9)===_0x4373d5(0x16d)&&_0x43f2c9[_0x4373d5(0xd6)]);}[_0x17a8e6(0x123)](_0x4b2c56){var _0x56220c=_0x17a8e6;if(_0x4b2c56[_0x56220c(0xa6)](/^\\d+$/))return _0x4b2c56;var _0x1bdee3;try{_0x1bdee3=JSON[_0x56220c(0xea)](''+_0x4b2c56);}catch{_0x1bdee3='\\x22'+this[_0x56220c(0xfa)](_0x4b2c56)+'\\x22';}return _0x1bdee3[_0x56220c(0xa6)](/^\"([a-zA-Z_][a-zA-Z_0-9]*)\"$/)?_0x1bdee3=_0x1bdee3['substr'](0x1,_0x1bdee3[_0x56220c(0x132)]-0x2):_0x1bdee3=_0x1bdee3[_0x56220c(0x16b)](/'/g,'\\x5c\\x27')[_0x56220c(0x16b)](/\\\\\"/g,'\\x22')['replace'](/(^\"|\"$)/g,'\\x27'),_0x1bdee3;}[_0x17a8e6(0xf1)](_0x12e5fa,_0x377aae,_0x479d3b,_0x22fee4){var _0x2371e8=_0x17a8e6;this[_0x2371e8(0x99)](_0x12e5fa,_0x377aae),_0x22fee4&&_0x22fee4(),this[_0x2371e8(0xf0)](_0x479d3b,_0x12e5fa),this['_treeNodePropertiesAfterFullValue'](_0x12e5fa,_0x377aae);}[_0x17a8e6(0x99)](_0x5c21fa,_0x1aecd1){var _0x282f65=_0x17a8e6;this['_setNodeId'](_0x5c21fa,_0x1aecd1),this[_0x282f65(0xd0)](_0x5c21fa,_0x1aecd1),this[_0x282f65(0x142)](_0x5c21fa,_0x1aecd1),this[_0x282f65(0x9d)](_0x5c21fa,_0x1aecd1);}['_setNodeId'](_0x14b97e,_0x579b0f){}[_0x17a8e6(0xd0)](_0x4c89ef,_0x53cddb){}[_0x17a8e6(0x165)](_0x5f2a86,_0x58024e){}[_0x17a8e6(0x144)](_0x337ea7){var _0x2da9f3=_0x17a8e6;return _0x337ea7===this[_0x2da9f3(0x117)];}['_treeNodePropertiesAfterFullValue'](_0x2bef82,_0x30352){var _0x43ff40=_0x17a8e6;this[_0x43ff40(0x165)](_0x2bef82,_0x30352),this[_0x43ff40(0xe4)](_0x2bef82),_0x30352[_0x43ff40(0x173)]&&this['_sortProps'](_0x2bef82),this['_addFunctionsNode'](_0x2bef82,_0x30352),this[_0x43ff40(0xf5)](_0x2bef82,_0x30352),this[_0x43ff40(0x128)](_0x2bef82);}[_0x17a8e6(0xf0)](_0x14f774,_0x5483ce){var _0x2749c5=_0x17a8e6;let _0x559efd;try{_0x3ee000[_0x2749c5(0xc9)]&&(_0x559efd=_0x3ee000[_0x2749c5(0xc9)][_0x2749c5(0xd1)],_0x3ee000[_0x2749c5(0xc9)][_0x2749c5(0xd1)]=function(){}),_0x14f774&&typeof _0x14f774[_0x2749c5(0x132)]=='number'&&(_0x5483ce[_0x2749c5(0x132)]=_0x14f774['length']);}catch{}finally{_0x559efd&&(_0x3ee000[_0x2749c5(0xc9)][_0x2749c5(0xd1)]=_0x559efd);}if(_0x5483ce['type']===_0x2749c5(0x95)||_0x5483ce['type']==='Number'){if(isNaN(_0x5483ce['value']))_0x5483ce[_0x2749c5(0x155)]=!0x0,delete _0x5483ce[_0x2749c5(0xb6)];else switch(_0x5483ce[_0x2749c5(0xb6)]){case Number[_0x2749c5(0x11d)]:_0x5483ce[_0x2749c5(0x130)]=!0x0,delete _0x5483ce['value'];break;case Number[_0x2749c5(0x150)]:_0x5483ce['negativeInfinity']=!0x0,delete _0x5483ce[_0x2749c5(0xb6)];break;case 0x0:this[_0x2749c5(0x156)](_0x5483ce['value'])&&(_0x5483ce[_0x2749c5(0x153)]=!0x0);break;}}else _0x5483ce['type']==='function'&&typeof _0x14f774[_0x2749c5(0x181)]==_0x2749c5(0x151)&&_0x14f774[_0x2749c5(0x181)]&&_0x5483ce[_0x2749c5(0x181)]&&_0x14f774[_0x2749c5(0x181)]!==_0x5483ce[_0x2749c5(0x181)]&&(_0x5483ce[_0x2749c5(0x14d)]=_0x14f774[_0x2749c5(0x181)]);}[_0x17a8e6(0x156)](_0x53b573){var _0x4d701f=_0x17a8e6;return 0x1/_0x53b573===Number[_0x4d701f(0x150)];}[_0x17a8e6(0x131)](_0x307c91){var _0x35071f=_0x17a8e6;!_0x307c91[_0x35071f(0x12e)]||!_0x307c91['props'][_0x35071f(0x132)]||_0x307c91[_0x35071f(0x160)]===_0x35071f(0x159)||_0x307c91[_0x35071f(0x160)]===_0x35071f(0xdd)||_0x307c91['type']===_0x35071f(0x158)||_0x307c91[_0x35071f(0x12e)][_0x35071f(0x115)](function(_0x4e9a2d,_0x3b3b0c){var _0x673aab=_0x35071f,_0x1b777a=_0x4e9a2d[_0x673aab(0x181)][_0x673aab(0xce)](),_0x45b38b=_0x3b3b0c[_0x673aab(0x181)]['toLowerCase']();return _0x1b777a<_0x45b38b?-0x1:_0x1b777a>_0x45b38b?0x1:0x0;});}[_0x17a8e6(0xbe)](_0xb00103,_0x1e38ea){var _0xb14144=_0x17a8e6;if(!(_0x1e38ea[_0xb14144(0x16a)]||!_0xb00103[_0xb14144(0x12e)]||!_0xb00103[_0xb14144(0x12e)][_0xb14144(0x132)])){for(var _0x237dd0=[],_0x24eb3c=[],_0x1553b0=0x0,_0x48bea3=_0xb00103[_0xb14144(0x12e)][_0xb14144(0x132)];_0x1553b0<_0x48bea3;_0x1553b0++){var _0x4f740f=_0xb00103[_0xb14144(0x12e)][_0x1553b0];_0x4f740f[_0xb14144(0x160)]===_0xb14144(0xe2)?_0x237dd0[_0xb14144(0x177)](_0x4f740f):_0x24eb3c[_0xb14144(0x177)](_0x4f740f);}if(!(!_0x24eb3c[_0xb14144(0x132)]||_0x237dd0[_0xb14144(0x132)]<=0x1)){_0xb00103[_0xb14144(0x12e)]=_0x24eb3c;var _0x321c26={'functionsNode':!0x0,'props':_0x237dd0};this[_0xb14144(0x9a)](_0x321c26,_0x1e38ea),this[_0xb14144(0x165)](_0x321c26,_0x1e38ea),this['_setNodeExpandableState'](_0x321c26),this[_0xb14144(0x9d)](_0x321c26,_0x1e38ea),_0x321c26['id']+='\\x20f',_0xb00103[_0xb14144(0x12e)][_0xb14144(0xf4)](_0x321c26);}}}[_0x17a8e6(0xf5)](_0x3f1143,_0x49fbb5){}[_0x17a8e6(0xe4)](_0x5dbd8a){}[_0x17a8e6(0x120)](_0xe0f14d){var _0x59bd5d=_0x17a8e6;return Array[_0x59bd5d(0xd5)](_0xe0f14d)||typeof _0xe0f14d==_0x59bd5d(0x12d)&&this[_0x59bd5d(0xfa)](_0xe0f14d)===_0x59bd5d(0x17c);}[_0x17a8e6(0x9d)](_0x176251,_0x1c2a62){}[_0x17a8e6(0x128)](_0x2cb448){var _0x1d0d73=_0x17a8e6;delete _0x2cb448['_hasSymbolPropertyOnItsPath'],delete _0x2cb448[_0x1d0d73(0xfe)],delete _0x2cb448[_0x1d0d73(0x183)];}['_setNodeExpressionPath'](_0x490699,_0x58ca72){}}let _0x53523a=new _0x301118(),_0x43d6e0={'props':0x64,'elements':0x64,'strLength':0x400*0x32,'totalStrLength':0x400*0x32,'autoExpandLimit':0x1388,'autoExpandMaxDepth':0xa},_0x496c1c={'props':0x5,'elements':0x5,'strLength':0x100,'totalStrLength':0x100*0x3,'autoExpandLimit':0x1e,'autoExpandMaxDepth':0x2};function _0x5b5e24(_0x5059b1,_0x5d7975,_0x4dd49b,_0x3d389f,_0x57d9bb,_0x4431c4){var _0x34e4dc=_0x17a8e6;let _0x38b128,_0x4df2d4;try{_0x4df2d4=_0x5ec0f4(),_0x38b128=_0x5c6da4[_0x5d7975],!_0x38b128||_0x4df2d4-_0x38b128['ts']>0x1f4&&_0x38b128[_0x34e4dc(0x174)]&&_0x38b128[_0x34e4dc(0x179)]/_0x38b128[_0x34e4dc(0x174)]<0x64?(_0x5c6da4[_0x5d7975]=_0x38b128={'count':0x0,'time':0x0,'ts':_0x4df2d4},_0x5c6da4[_0x34e4dc(0xa0)]={}):_0x4df2d4-_0x5c6da4[_0x34e4dc(0xa0)]['ts']>0x32&&_0x5c6da4['hits'][_0x34e4dc(0x174)]&&_0x5c6da4['hits'][_0x34e4dc(0x179)]/_0x5c6da4[_0x34e4dc(0xa0)][_0x34e4dc(0x174)]<0x64&&(_0x5c6da4[_0x34e4dc(0xa0)]={});let _0x396689=[],_0x2f89bf=_0x38b128[_0x34e4dc(0x154)]||_0x5c6da4[_0x34e4dc(0xa0)][_0x34e4dc(0x154)]?_0x496c1c:_0x43d6e0,_0x5a7dca=_0x5a9db9=>{var _0x26e167=_0x34e4dc;let _0x4f2e5c={};return _0x4f2e5c['props']=_0x5a9db9[_0x26e167(0x12e)],_0x4f2e5c[_0x26e167(0x164)]=_0x5a9db9[_0x26e167(0x164)],_0x4f2e5c[_0x26e167(0xb8)]=_0x5a9db9[_0x26e167(0xb8)],_0x4f2e5c['totalStrLength']=_0x5a9db9[_0x26e167(0x109)],_0x4f2e5c[_0x26e167(0x11e)]=_0x5a9db9[_0x26e167(0x11e)],_0x4f2e5c['autoExpandMaxDepth']=_0x5a9db9['autoExpandMaxDepth'],_0x4f2e5c['sortProps']=!0x1,_0x4f2e5c[_0x26e167(0x16a)]=!_0x2306de,_0x4f2e5c[_0x26e167(0xf3)]=0x1,_0x4f2e5c[_0x26e167(0x148)]=0x0,_0x4f2e5c[_0x26e167(0xd7)]=_0x26e167(0xff),_0x4f2e5c[_0x26e167(0xee)]=_0x26e167(0x157),_0x4f2e5c[_0x26e167(0x11f)]=!0x0,_0x4f2e5c[_0x26e167(0xab)]=[],_0x4f2e5c[_0x26e167(0xad)]=0x0,_0x4f2e5c['resolveGetters']=!0x0,_0x4f2e5c['allStrLength']=0x0,_0x4f2e5c[_0x26e167(0x10b)]={'current':void 0x0,'parent':void 0x0,'index':0x0},_0x4f2e5c;};for(var _0x146f4c=0x0;_0x146f4c<_0x57d9bb[_0x34e4dc(0x132)];_0x146f4c++)_0x396689['push'](_0x53523a[_0x34e4dc(0x12f)]({'timeNode':_0x5059b1===_0x34e4dc(0x179)||void 0x0},_0x57d9bb[_0x146f4c],_0x5a7dca(_0x2f89bf),{}));if(_0x5059b1==='trace'){let _0x5149fe=Error[_0x34e4dc(0xbf)];try{Error[_0x34e4dc(0xbf)]=0x1/0x0,_0x396689[_0x34e4dc(0x177)](_0x53523a[_0x34e4dc(0x12f)]({'stackNode':!0x0},new Error()[_0x34e4dc(0xaa)],_0x5a7dca(_0x2f89bf),{'strLength':0x1/0x0}));}finally{Error['stackTraceLimit']=_0x5149fe;}}return{'method':_0x34e4dc(0xc2),'version':_0x2fad6a,'args':[{'ts':_0x4dd49b,'session':_0x3d389f,'args':_0x396689,'id':_0x5d7975,'context':_0x4431c4}]};}catch(_0x4dc790){return{'method':_0x34e4dc(0xc2),'version':_0x2fad6a,'args':[{'ts':_0x4dd49b,'session':_0x3d389f,'args':[{'type':_0x34e4dc(0x137),'error':_0x4dc790&&_0x4dc790['message']}],'id':_0x5d7975,'context':_0x4431c4}]};}finally{try{if(_0x38b128&&_0x4df2d4){let _0x40ec0f=_0x5ec0f4();_0x38b128[_0x34e4dc(0x174)]++,_0x38b128['time']+=_0x6927e(_0x4df2d4,_0x40ec0f),_0x38b128['ts']=_0x40ec0f,_0x5c6da4['hits'][_0x34e4dc(0x174)]++,_0x5c6da4[_0x34e4dc(0xa0)][_0x34e4dc(0x179)]+=_0x6927e(_0x4df2d4,_0x40ec0f),_0x5c6da4[_0x34e4dc(0xa0)]['ts']=_0x40ec0f,(_0x38b128[_0x34e4dc(0x174)]>0x32||_0x38b128[_0x34e4dc(0x179)]>0x64)&&(_0x38b128[_0x34e4dc(0x154)]=!0x0),(_0x5c6da4[_0x34e4dc(0xa0)]['count']>0x3e8||_0x5c6da4['hits']['time']>0x12c)&&(_0x5c6da4[_0x34e4dc(0xa0)]['reduceLimits']=!0x0);}}catch{}}}return _0x5b5e24;}((_0x9399bd,_0x2365d5,_0x464d40,_0x4ef92e,_0x47b116,_0xf6922b,_0x242faa,_0x10413a,_0x1f4ec5,_0x5231c0,_0x2a3837)=>{var _0x55e5a2=_0x535e93;if(_0x9399bd[_0x55e5a2(0xe0)])return _0x9399bd[_0x55e5a2(0xe0)];if(!X(_0x9399bd,_0x10413a,_0x47b116))return _0x9399bd[_0x55e5a2(0xe0)]={'consoleLog':()=>{},'consoleTrace':()=>{},'consoleTime':()=>{},'consoleTimeEnd':()=>{},'autoLog':()=>{},'autoLogMany':()=>{},'autoTraceMany':()=>{},'coverage':()=>{},'autoTrace':()=>{},'autoTime':()=>{},'autoTimeEnd':()=>{}},_0x9399bd[_0x55e5a2(0xe0)];let _0x259114=b(_0x9399bd),_0x97b010=_0x259114[_0x55e5a2(0x114)],_0x4f172a=_0x259114[_0x55e5a2(0xcf)],_0x531c6f=_0x259114[_0x55e5a2(0xbc)],_0x5b7357={'hits':{},'ts':{}},_0x166420=H(_0x9399bd,_0x1f4ec5,_0x5b7357,_0xf6922b),_0x101ce2=_0x36af0f=>{_0x5b7357['ts'][_0x36af0f]=_0x4f172a();},_0xdac40e=(_0x1547b7,_0x6ebb51)=>{var _0x5548e1=_0x55e5a2;let _0x5f096a=_0x5b7357['ts'][_0x6ebb51];if(delete _0x5b7357['ts'][_0x6ebb51],_0x5f096a){let _0x2de683=_0x97b010(_0x5f096a,_0x4f172a());_0x5b8d72(_0x166420(_0x5548e1(0x179),_0x1547b7,_0x531c6f(),_0x52ba41,[_0x2de683],_0x6ebb51));}},_0x186570=_0x3467d5=>{var _0x2e1d44=_0x55e5a2,_0x12187e;return _0x47b116===_0x2e1d44(0x9b)&&_0x9399bd[_0x2e1d44(0x168)]&&((_0x12187e=_0x3467d5==null?void 0x0:_0x3467d5[_0x2e1d44(0xe5)])==null?void 0x0:_0x12187e[_0x2e1d44(0x132)])&&(_0x3467d5[_0x2e1d44(0xe5)][0x0]['origin']=_0x9399bd[_0x2e1d44(0x168)]),_0x3467d5;};_0x9399bd[_0x55e5a2(0xe0)]={'consoleLog':(_0x2b8fad,_0x4547f3)=>{var _0x167f84=_0x55e5a2;_0x9399bd[_0x167f84(0xc9)]['log']['name']!==_0x167f84(0xaf)&&_0x5b8d72(_0x166420(_0x167f84(0xc2),_0x2b8fad,_0x531c6f(),_0x52ba41,_0x4547f3));},'consoleTrace':(_0x4f5f02,_0x20652f)=>{var _0x2f8171=_0x55e5a2;_0x9399bd['console'][_0x2f8171(0xc2)][_0x2f8171(0x181)]!==_0x2f8171(0x10c)&&_0x5b8d72(_0x186570(_0x166420(_0x2f8171(0x134),_0x4f5f02,_0x531c6f(),_0x52ba41,_0x20652f)));},'consoleTime':_0x5abf9e=>{_0x101ce2(_0x5abf9e);},'consoleTimeEnd':(_0x5bfd8d,_0x40e8e1)=>{_0xdac40e(_0x40e8e1,_0x5bfd8d);},'autoLog':(_0xae97ad,_0x34ce66)=>{var _0x4e2db1=_0x55e5a2;_0x5b8d72(_0x166420(_0x4e2db1(0xc2),_0x34ce66,_0x531c6f(),_0x52ba41,[_0xae97ad]));},'autoLogMany':(_0x56fa63,_0x454eed)=>{var _0x578d2c=_0x55e5a2;_0x5b8d72(_0x166420(_0x578d2c(0xc2),_0x56fa63,_0x531c6f(),_0x52ba41,_0x454eed));},'autoTrace':(_0x4243f3,_0x5d41e7)=>{var _0x3966d1=_0x55e5a2;_0x5b8d72(_0x186570(_0x166420(_0x3966d1(0x134),_0x5d41e7,_0x531c6f(),_0x52ba41,[_0x4243f3])));},'autoTraceMany':(_0x2522ab,_0x549f86)=>{_0x5b8d72(_0x186570(_0x166420('trace',_0x2522ab,_0x531c6f(),_0x52ba41,_0x549f86)));},'autoTime':(_0x37a119,_0x1f2056,_0x18191c)=>{_0x101ce2(_0x18191c);},'autoTimeEnd':(_0x26ba64,_0x1f827a,_0x561251)=>{_0xdac40e(_0x1f827a,_0x561251);},'coverage':_0x5130ce=>{var _0x142c72=_0x55e5a2;_0x5b8d72({'method':_0x142c72(0x96),'version':_0xf6922b,'args':[{'id':_0x5130ce}]});}};let _0x5b8d72=q(_0x9399bd,_0x2365d5,_0x464d40,_0x4ef92e,_0x47b116,_0x5231c0,_0x2a3837),_0x52ba41=_0x9399bd[_0x55e5a2(0xe1)];return _0x9399bd['_console_ninja'];})(globalThis,'127.0.0.1',_0x535e93(0x13b),_0x535e93(0x143),'next.js',_0x535e93(0x13a),'1718722318190',_0x535e93(0xc5),_0x535e93(0x15e),_0x535e93(0xd2),_0x535e93(0xb3));");}catch(e){}};/* istanbul ignore next */function oo_oo(i,...v){try{oo_cm().consoleLog(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_tr(i,...v){try{oo_cm().consoleTrace(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_ts(v){try{oo_cm().consoleTime(v);}catch(e){} return v;};/* istanbul ignore next */function oo_te(v, i){try{oo_cm().consoleTimeEnd(v, i);}catch(e){} return v;};/*eslint unicorn/no-abusive-eslint-disable:,eslint-comments/disable-enable-pair:,eslint-comments/no-unlimited-disable:,eslint-comments/no-aggregating-enable:,eslint-comments/no-duplicate-disable:,eslint-comments/no-unused-disable:,eslint-comments/no-unused-enable:,*/