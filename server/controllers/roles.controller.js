import * as roles from '../services/roles.service.js';
import * as users from '../services/users.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const listRoles = async (req, res) => ok(res, await roles.listRoles(req, req.query));
export const getRole = async (req, res) => ok(res, await roles.getRole(req, req.params.id));
export const createRole = async (req, res) => ok(res, await roles.createRole(req, req.body), 201);
export const updateRole = async (req, res) => ok(res, await roles.updateRole(req, req.params.id, req.body));
export const deleteRole = async (req, res) => ok(res, await roles.deleteRole(req, req.params.id));

export const listUsers = async (req, res) => ok(res, await users.listUsers(req, req.query));
export const createUser = async (req, res) => ok(res, await users.createUser(req, req.body), 201);
export const updateUser = async (req, res) => ok(res, await users.updateUser(req, req.params.id, req.body));
export const deactivateUser = async (req, res) => ok(res, await users.deactivateUser(req, req.params.id));
